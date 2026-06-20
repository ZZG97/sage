// TaskScheduler — public façade for bunqueue-based scheduled work.
// Implementation details live under ./scheduler to keep scheduler ownership explicit.
import { Queue, Worker, type JobOptions } from 'bunqueue/client';
import { createRequestId, Logger, runWithRequestContext } from '../utils';
import { buildDynamicTask, DynamicTaskRepository } from './scheduler/dynamic-task-repository';
import { SchedulerRunRecorder } from './scheduler/scheduler-run-recorder';
import type {
  BuiltinTaskDef,
  BuiltinTaskSummary,
  DynamicTask,
  DynamicTaskContext,
  DynamicTaskKind,
  DynamicTaskWriteOptions,
  SchedulerQueue,
  TaskContext,
  TaskHandler,
  TaskJobData,
} from './scheduler/types';
import { normalizeWorkflowPayload } from './scheduler/workflow-normalizer';
import { WorkflowRunner } from './scheduler/workflow-runner';

export type {
  AgentTaskRunOptions,
  BuiltinTaskDef,
  BuiltinTaskSummary,
  DynamicTask,
  DynamicTaskContext,
  DynamicTaskKind,
  DynamicTaskWriteOptions,
  TaskContext,
  TaskHandler,
  WorkflowAgentStep,
  WorkflowJobOptions,
  WorkflowShellStep,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTaskPayload,
} from './scheduler/types';

const QUEUE_NAME = 'sage:tasks';
const TIMEZONE = 'Asia/Shanghai';

interface TaskSchedulerOptions {
  logger?: Logger;
  queue?: SchedulerQueue;
  repository?: DynamicTaskRepository;
  workflowRunner?: WorkflowRunner;
  runRecorder?: SchedulerRunRecorder;
}

export class TaskScheduler {
  private queue: SchedulerQueue;
  private worker: Worker<TaskJobData> | undefined;
  private builtinHandlers: Map<string, TaskHandler> = new Map();
  private builtinDefs: Map<string, BuiltinTaskSummary> = new Map();
  private ctx: TaskContext;
  private repository: DynamicTaskRepository;
  private workflowRunner: WorkflowRunner;
  private runRecorder: SchedulerRunRecorder;
  private logger: Logger;
  private isDev: boolean;

  constructor(ctx: TaskContext, isDev: boolean = false, options: TaskSchedulerOptions = {}) {
    this.ctx = ctx;
    this.isDev = isDev;
    this.logger = options.logger || new Logger('TaskScheduler');

    this.queue = options.queue || (new Queue<TaskJobData>(QUEUE_NAME, {
      embedded: true,
    }) as unknown as SchedulerQueue);
    this.queue.setStallConfig?.({ enabled: false });

    this.repository = options.repository || DynamicTaskRepository.openDefault(isDev, this.logger);
    this.workflowRunner = options.workflowRunner || new WorkflowRunner({
      runAgentPrompt: (prompt, title, context) => this.runAgentPrompt(prompt, title, context),
    });
    this.runRecorder = options.runRecorder || new SchedulerRunRecorder();
  }

  /** Register a built-in task (call before start) */
  registerBuiltin(def: BuiltinTaskDef): void {
    if (this.isDev && !def.allowInDev) {
      this.logger.info(`跳过注册 (dev): ${def.name}`);
      return;
    }
    this.builtinHandlers.set(def.name, def.handler);
    this.builtinDefs.set(def.name, {
      name: def.name,
      pattern: def.pattern,
      allowInDev: Boolean(def.allowInDev),
    });
    this.logger.info(`注册内置任务: ${def.name} (${def.pattern})`);
  }

  /** Start the scheduler — registers all jobs with bunqueue */
  async start(builtinDefs: BuiltinTaskDef[]): Promise<void> {
    for (const def of builtinDefs) {
      if (this.isDev && !def.allowInDev) continue;
      this.builtinHandlers.set(def.name, def.handler);
      this.builtinDefs.set(def.name, {
        name: def.name,
        pattern: def.pattern,
        allowInDev: Boolean(def.allowInDev),
      });

      await this.queue.upsertJobScheduler(
        `builtin:${def.name}`,
        { pattern: def.pattern, timezone: TIMEZONE },
        { name: 'task', data: { type: 'builtin', task_id: def.name } },
      );
      this.logger.info(`注册内置任务: ${def.name} (${def.pattern})`);
    }

    await this.reloadDynamicTasks();

    this.worker = new Worker<TaskJobData>(
      QUEUE_NAME,
      (job) => this.processJob({ data: job.data }),
      {
        embedded: true,
        concurrency: 2,
        useLocks: false,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 50 },
      },
    );
    this.worker.on('error', (err) => {
      this.logger.error('Worker error:', err);
    });

    this.logger.info(`调度器已启动，${this.builtinHandlers.size} 个内置任务`);
  }

  /** Graceful shutdown */
  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    this.queue.close();
    this.repository.close();
    this.logger.info('调度器已停止');
  }

  /** Create a dynamic scheduled task (recurring or one-shot) */
  async createDynamicTask(opts: DynamicTaskWriteOptions): Promise<DynamicTask> {
    const id = crypto.randomUUID();
    const task = buildDynamicTask(id, opts, Date.now());

    this.repository.insert(task);
    try {
      await this.registerDynamicTask(task);
    } catch (error) {
      this.repository.delete(id);
      throw error;
    }

    return task;
  }

  /** List all dynamic tasks */
  listDynamicTasks(includeCompleted = false): DynamicTask[] {
    return this.repository.list(includeCompleted);
  }

  /** List registered built-in tasks */
  listBuiltinTasks(): BuiltinTaskSummary[] {
    return Array.from(this.builtinDefs.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Remove a dynamic task */
  async removeDynamicTask(id: string): Promise<boolean> {
    const task = this.repository.getById(id);
    if (!task) return false;

    await this.unregisterDynamicTask(task);

    this.repository.markCancelled(id);
    this.logger.info(`删除动态任务: ${id}`);
    return true;
  }

  /** Update an active dynamic task and refresh its bunqueue registration */
  async updateDynamicTask(id: string, opts: DynamicTaskWriteOptions): Promise<DynamicTask | null> {
    const existing = this.repository.getById(id);
    if (!existing) return null;

    if (existing.status !== 'active') {
      throw new Error('只能更新 active 状态的动态任务');
    }

    const nextTask = buildDynamicTask(id, opts, existing.created_at);

    await this.unregisterDynamicTask(existing);
    this.repository.updateTask(nextTask);

    try {
      await this.registerDynamicTask(nextTask);
      this.logger.info(`更新动态任务(${nextTask.kind}): ${id}`);
      return nextTask;
    } catch (error) {
      this.repository.updateTask(existing);

      try {
        await this.registerDynamicTask(existing);
      } catch (restoreError) {
        this.logger.error(`恢复动态任务失败: ${id}`, restoreError);
      }
      throw error;
    }
  }

  /** Manually trigger a built-in task (for testing) */
  async runNow(name: string): Promise<void> {
    const handler = this.builtinHandlers.get(name);
    if (!handler) {
      throw new Error(`内置任务不存在: ${name}`);
    }
    this.logger.info(`手动触发: ${name}`);
    await handler(this.ctx);
  }

  private buildDynamicJobData(task: DynamicTask): TaskJobData {
    return {
      type: 'dynamic',
      task_id: task.id,
      kind: task.kind,
      message: task.message,
      title: task.title || undefined,
      payload: task.payload ? JSON.stringify(task.payload) : undefined,
      context: task.context ? JSON.stringify(task.context) : undefined,
    };
  }

  /** Reload active dynamic tasks from SQLite into bunqueue */
  private async reloadDynamicTasks(): Promise<void> {
    const tasks = this.repository.list(false);
    const now = Date.now();
    let loaded = 0;

    for (const task of tasks) {
      if (task.trigger_at && task.trigger_at <= now) {
        this.repository.markCompleted(task.id);
        continue;
      }
      await this.registerDynamicTask(task);
      loaded++;
    }

    if (loaded > 0) {
      this.logger.info(`恢复 ${loaded} 个动态任务`);
    }
  }

  /** Process a job from the queue */
  private async processJob(job: { data: TaskJobData }): Promise<void> {
    const { type, task_id, kind } = job.data;
    const contextKind = type === 'builtin' ? 'builtin' : (kind || 'message');

    return runWithRequestContext({
      requestId: createRequestId('job'),
      source: 'scheduler',
      taskId: task_id,
      runId: createRequestId('run'),
      kind: contextKind,
    }, () => this.runRecorder.record(job.data, async (operation) => {
      if (type === 'builtin') {
        await this.executeBuiltinTask(task_id, operation);
        return;
      }

      await this.executeDynamicTask(job.data, operation);
    }));
  }

  private async executeBuiltinTask(
    taskId: string,
    operation: { warn: (message: string) => void; success: (options?: { summary?: string }) => void },
  ): Promise<void> {
    const handler = this.builtinHandlers.get(taskId);
    if (!handler) {
      this.logger.warn(`内置任务 handler 未找到: ${taskId}`);
      operation.warn('handler not found');
      operation.success({ summary: 'handler not found' });
      return;
    }

    this.logger.info(`执行内置任务: ${taskId}`);
    const start = Date.now();
    try {
      await handler(this.ctx);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      this.logger.info(`任务完成: ${taskId} (${elapsed}s)`);
      operation.success({ summary: `completed in ${elapsed}s` });
    } catch (error) {
      this.logger.error(`任务失败: ${taskId}`, error);
      throw error;
    }
  }

  private async executeDynamicTask(
    jobData: TaskJobData,
    operation: {
      addMetrics: (metrics: Record<string, number | string | boolean | null>) => void;
      success: (options?: { summary?: string }) => void;
      warn: (message: string) => void;
    },
  ): Promise<void> {
    const { task_id, kind, message, title, payload, context } = jobData;
    const effectiveKind: DynamicTaskKind = kind || 'message';
    this.logger.info(`执行动态任务(${effectiveKind}): ${task_id}`);

    try {
      const taskContext = this.parseTaskContext(context);
      if (effectiveKind === 'agent') {
        await this.runAgentPrompt(message || '(空 prompt)', title, taskContext);
        this.logger.info(`动态 agent 任务已完成: ${task_id}`);
      } else if (effectiveKind === 'workflow') {
        if (!payload) {
          throw new Error('workflow 任务缺少 payload');
        }
        const workflow = normalizeWorkflowPayload(JSON.parse(payload));
        await this.workflowRunner.run(task_id, workflow, title || undefined, taskContext);
        this.logger.info(`动态 workflow 任务已完成: ${task_id}`);
      } else {
        if (!this.ctx.sendMessageToOwner) {
          this.logger.warn('sendMessageToOwner 未注入，跳过 message 类动态任务');
          operation.warn('sendMessageToOwner not configured');
          operation.success({ summary: 'sendMessageToOwner not configured' });
          return;
        }
        await this.ctx.sendMessageToOwner(message || '(空消息)');
        this.logger.info(`动态消息任务已发送: ${task_id}`);
      }
    } catch (error) {
      this.logger.error(`动态任务失败: ${task_id}`, error);
      throw error;
    }

    const task = this.repository.getById(task_id);
    if (task?.trigger_at) {
      this.repository.markCompleted(task_id);
      this.logger.info(`一次性任务已完成: ${task_id}`);
      operation.addMetrics({ one_shot_completed: true });
    }
    operation.success({ summary: `${effectiveKind} task completed` });
  }

  private parseTaskContext(serialized?: string): DynamicTaskContext | undefined {
    if (!serialized) return undefined;
    try {
      const parsed = JSON.parse(serialized) as DynamicTaskContext;
      return parsed?.reuseConversationId
        ? { reuseConversationId: String(parsed.reuseConversationId) }
        : undefined;
    } catch (error) {
      this.logger.warn(`任务 context 解析失败: ${String(error)}`);
      return undefined;
    }
  }

  private async runAgentPrompt(prompt: string, title?: string, context?: DynamicTaskContext): Promise<void> {
    if (this.ctx.runAgentTask) {
      await this.ctx.runAgentTask(prompt, title, context);
      return;
    }

    const session = await this.ctx.agent.createSession();
    try {
      await this.ctx.agent.sendMessage(session.id, prompt);
    } finally {
      await this.ctx.agent.deleteSession(session.id);
    }
  }

  private async registerDynamicTask(task: DynamicTask): Promise<void> {
    const jobData = this.buildDynamicJobData(task);
    const jobOptions = this.buildDynamicJobOptions(task);

    if (task.trigger_at) {
      const delay = task.trigger_at - Date.now();
      if (delay <= 0) {
        throw new Error('triggerAt must be in the future');
      }
      await this.queue.add('task', jobData, { ...jobOptions, delay, jobId: `dynamic:${task.id}` });
      this.logger.info(
        `注册一次性任务(${task.kind}): ${task.id}, 将在 ${new Date(task.trigger_at).toLocaleString('zh-CN', { timeZone: TIMEZONE })} 触发`,
      );
      return;
    }

    if (!task.pattern) {
      throw new Error('动态任务缺少 pattern / trigger_at');
    }

    await this.queue.upsertJobScheduler(
      `dynamic:${task.id}`,
      { pattern: task.pattern, timezone: TIMEZONE },
      { name: 'task', data: jobData, opts: jobOptions },
    );
    this.logger.info(`注册周期任务(${task.kind}): ${task.id}, pattern=${task.pattern}`);
  }

  private buildDynamicJobOptions(task: DynamicTask): JobOptions | undefined {
    if (task.kind !== 'workflow' || !task.payload?.jobOptions) {
      return undefined;
    }
    return task.payload.jobOptions;
  }

  private async unregisterDynamicTask(task: Pick<DynamicTask, 'id' | 'pattern' | 'trigger_at'>): Promise<void> {
    if (task.pattern) {
      try { await this.queue.removeJobScheduler(`dynamic:${task.id}`); } catch { /* may not exist */ }
      return;
    }

    try { await this.queue.removeAsync(`dynamic:${task.id}`); } catch { /* may have fired */ }
  }
}
