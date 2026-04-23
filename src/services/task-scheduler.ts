// TaskScheduler — bunqueue-based task scheduler with dynamic task support
// Replaces the old setInterval-based Scheduler
import { Queue, Worker } from 'bunqueue/client';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { Logger } from '../utils';
import type { AgentProvider } from '../agent/types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TaskContext {
  agent: AgentProvider;
  logger: Logger;
  /** 主动向 owner 发纯文本消息（由 SageCore 注入），返回 message_id */
  sendMessageToOwner?: (text: string) => Promise<string | void>;
  /** 主动触发一次 agent 任务并以流式卡片发送给 owner（由 SageCore 注入） */
  runAgentTask?: (prompt: string, title?: string) => Promise<void>;
}

/** Handler function for built-in tasks */
export type TaskHandler = (ctx: TaskContext) => Promise<void>;

/** Schedule config for built-in tasks */
export interface BuiltinTaskDef {
  name: string;
  /** Cron pattern, e.g. "0 8 * * *" for daily 8:00 */
  pattern: string;
  handler: TaskHandler;
  /** Allow in dev environment (default false) */
  allowInDev?: boolean;
}

export interface BuiltinTaskSummary {
  name: string;
  pattern: string;
  allowInDev: boolean;
}

export type DynamicTaskKind = 'message' | 'agent' | 'workflow';
export type WorkflowStepKind = 'shell' | 'agent';

export interface WorkflowShellStep {
  id?: string;
  kind: 'shell';
  command: string;
  cwd?: string | null;
  timeoutSec?: number | null;
}

export interface WorkflowAgentStep {
  id?: string;
  kind: 'agent';
  prompt: string;
  title?: string | null;
}

export type WorkflowStep = WorkflowShellStep | WorkflowAgentStep;

export interface WorkflowTaskPayload {
  version: 1;
  steps: WorkflowStep[];
}

export interface DynamicTaskWriteOptions {
  kind?: DynamicTaskKind;
  message: string;
  title?: string;
  payload?: WorkflowTaskPayload;
  pattern?: string;
  triggerAt?: number;
}

/** A dynamic scheduled task stored in SQLite */
export interface DynamicTask {
  id: string;
  /** message=纯文本提醒；agent=单步 agent；workflow=顺序执行多个 step */
  kind: DynamicTaskKind;
  /** message 文本；agent prompt；workflow 的人类可读摘要 */
  message: string;
  /** agent / workflow 主标题 */
  title: string | null;
  /** workflow 结构化定义 */
  payload: WorkflowTaskPayload | null;
  /** Cron pattern (recurring) OR null for one-shot */
  pattern: string | null;
  /** Epoch ms for one-shot trigger time */
  trigger_at: number | null;
  /** active / completed / cancelled */
  status: string;
  created_at: number;
}

interface RawDynamicTask extends Omit<DynamicTask, 'payload'> {
  payload: string | null;
}

/** Job data flowing through bunqueue */
interface TaskJobData {
  type: 'builtin' | 'dynamic';
  /** For builtin: task name; for dynamic: task id */
  task_id: string;
  /** For dynamic: kind */
  kind?: DynamicTaskKind;
  /** For dynamic: text/prompt/summary */
  message?: string;
  /** For dynamic agent/workflow: proactive topic text */
  title?: string;
  /** For workflow: serialized payload */
  payload?: string;
}

interface WorkflowStepRunRecord {
  stepId: string;
  kind: WorkflowStepKind;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outputDir: string;
  title?: string | null;
  command?: string;
  cwd?: string;
  timeoutSec?: number;
  exitCode?: number;
  timedOut?: boolean;
  stdoutPath?: string;
  stderrPath?: string;
  promptPath?: string;
  preview?: string;
}

const QUEUE_NAME = 'sage:tasks';
const TIMEZONE = 'Asia/Shanghai';
const DEFAULT_SHELL_TIMEOUT_SEC = 60 * 60;
const PREVIEW_CHAR_LIMIT = 1200;

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  return await new Response(stream).text();
}

function expandHomeDir(input?: string | null): string | undefined {
  if (!input) return undefined;
  if (input.startsWith('~')) {
    return input.replace('~', process.env.HOME || '');
  }
  return input;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(${text.length - maxChars} chars truncated)`;
}

function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `...(${text.length - maxChars} chars omitted)\n${text.slice(-maxChars)}`;
}

function sanitizePathSegment(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'step';
}

function formatRunTimestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function summarizeWorkflowPayload(payload: WorkflowTaskPayload): string {
  return payload.steps
    .map((step, index) => {
      if (step.kind === 'shell') {
        return `${index + 1}. shell: ${truncateText(step.command.replace(/\s+/g, ' '), 100)}`;
      }
      return `${index + 1}. agent: ${truncateText(step.prompt.replace(/\s+/g, ' '), 100)}`;
    })
    .join('\n');
}

function normalizeWorkflowPayload(input: unknown): WorkflowTaskPayload {
  if (!input || typeof input !== 'object') {
    throw new Error('workflow payload 必须是对象');
  }

  const raw = input as { version?: unknown; steps?: unknown };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('workflow.steps 必须是非空数组');
  }

  const steps: WorkflowStep[] = raw.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`workflow.steps[${index}] 必须是对象`);
    }

    const step = candidate as Record<string, unknown>;
    const id = typeof step.id === 'string' && step.id.trim()
      ? step.id.trim()
      : `step_${String(index + 1).padStart(2, '0')}`;

    if (step.kind === 'shell') {
      const command = typeof step.command === 'string' ? step.command.trim() : '';
      if (!command) {
        throw new Error(`workflow.steps[${index}].command 不能为空`);
      }
      const cwd = typeof step.cwd === 'string' && step.cwd.trim() ? step.cwd.trim() : null;
      const timeoutSec = typeof step.timeoutSec === 'number' && Number.isFinite(step.timeoutSec)
        ? Math.max(1, Math.floor(step.timeoutSec))
        : null;
      return { id, kind: 'shell', command, cwd, timeoutSec };
    }

    if (step.kind === 'agent') {
      const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : '';
      if (!prompt) {
        throw new Error(`workflow.steps[${index}].prompt 不能为空`);
      }
      const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : null;
      return { id, kind: 'agent', prompt, title };
    }

    throw new Error(`workflow.steps[${index}].kind 仅支持 shell / agent`);
  });

  return {
    version: 1,
    steps,
  };
}

// ─── TaskScheduler ───────────────────────────────────────────────────────────

export class TaskScheduler {
  private queue: Queue<TaskJobData>;
  private worker: Worker<TaskJobData> | undefined;
  private builtinHandlers: Map<string, TaskHandler> = new Map();
  private builtinDefs: Map<string, BuiltinTaskSummary> = new Map();
  private ctx: TaskContext;
  private db: Database;
  private logger: Logger;
  private isDev: boolean;

  constructor(ctx: TaskContext, isDev: boolean = false) {
    this.ctx = ctx;
    this.isDev = isDev;
    this.logger = new Logger('TaskScheduler');

    this.queue = new Queue<TaskJobData>(QUEUE_NAME, {
      embedded: true,
    });
    this.queue.setStallConfig({ enabled: false });

    const dbFile = isDev ? 'scheduler-dev.db' : 'scheduler.db';
    const dbPath = resolve(import.meta.dir, `../../data/${dbFile}`);
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dynamic_tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        title TEXT,
        payload TEXT,
        pattern TEXT,
        trigger_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      )
    `);

    const cols = this.db.query(`PRAGMA table_info(dynamic_tasks)`).all() as Array<{ name: string }>;
    const hasKind = cols.some((c) => c.name === 'kind');
    if (!hasKind) {
      this.db.exec(`ALTER TABLE dynamic_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'`);
      this.logger.info('dynamic_tasks 表迁移：新增 kind 字段');
    }
    const hasTitle = cols.some((c) => c.name === 'title');
    if (!hasTitle) {
      this.db.exec(`ALTER TABLE dynamic_tasks ADD COLUMN title TEXT`);
      this.logger.info('dynamic_tasks 表迁移：新增 title 字段');
    }
    const hasPayload = cols.some((c) => c.name === 'payload');
    if (!hasPayload) {
      this.db.exec(`ALTER TABLE dynamic_tasks ADD COLUMN payload TEXT`);
      this.logger.info('dynamic_tasks 表迁移：新增 payload 字段');
    }
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
      (job) => this.processJob(job),
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
    this.db.close();
    this.logger.info('调度器已停止');
  }

  // ─── Dynamic Task CRUD ─────────────────────────────────────────────────────

  /** Create a dynamic scheduled task (recurring or one-shot) */
  async createDynamicTask(opts: DynamicTaskWriteOptions): Promise<DynamicTask> {
    const id = crypto.randomUUID();
    const task = this.normalizeDynamicTask(id, opts, Date.now());

    this.insertDynamicTask(task);
    try {
      await this.registerDynamicTask(task);
    } catch (error) {
      this.db.run('DELETE FROM dynamic_tasks WHERE id = ?', [id]);
      throw error;
    }

    return task;
  }

  /** List all dynamic tasks */
  listDynamicTasks(includeCompleted = false): DynamicTask[] {
    const sql = includeCompleted
      ? 'SELECT * FROM dynamic_tasks ORDER BY created_at DESC'
      : "SELECT * FROM dynamic_tasks WHERE status = 'active' ORDER BY created_at DESC";
    const rows = this.db.query(sql).all() as RawDynamicTask[];
    return rows.map((row) => this.deserializeDynamicTask(row));
  }

  /** List registered built-in tasks */
  listBuiltinTasks(): BuiltinTaskSummary[] {
    return Array.from(this.builtinDefs.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Remove a dynamic task */
  async removeDynamicTask(id: string): Promise<boolean> {
    const task = this.getRawDynamicTaskById(id);
    if (!task) return false;

    await this.unregisterDynamicTask(this.deserializeDynamicTask(task));

    this.db.run("UPDATE dynamic_tasks SET status = 'cancelled' WHERE id = ?", [id]);
    this.logger.info(`删除动态任务: ${id}`);
    return true;
  }

  /** Update an active dynamic task and refresh its bunqueue registration */
  async updateDynamicTask(id: string, opts: DynamicTaskWriteOptions): Promise<DynamicTask | null> {
    const existingRaw = this.getRawDynamicTaskById(id);
    if (!existingRaw) return null;

    const existing = this.deserializeDynamicTask(existingRaw);
    if (existing.status !== 'active') {
      throw new Error('只能更新 active 状态的动态任务');
    }

    const nextTask = this.normalizeDynamicTask(id, opts, existing.created_at);
    const restorePayload = existing.payload ? JSON.stringify(existing.payload) : null;

    await this.unregisterDynamicTask(existing);

    this.db.run(
      `UPDATE dynamic_tasks
       SET kind = ?, message = ?, title = ?, payload = ?, pattern = ?, trigger_at = ?
       WHERE id = ?`,
      [
        nextTask.kind,
        nextTask.message,
        nextTask.title,
        nextTask.payload ? JSON.stringify(nextTask.payload) : null,
        nextTask.pattern,
        nextTask.trigger_at,
        id,
      ],
    );

    try {
      await this.registerDynamicTask(nextTask);
      this.logger.info(`更新动态任务(${nextTask.kind}): ${id}`);
      return nextTask;
    } catch (error) {
      this.db.run(
        `UPDATE dynamic_tasks
         SET kind = ?, message = ?, title = ?, payload = ?, pattern = ?, trigger_at = ?
         WHERE id = ?`,
        [
          existing.kind,
          existing.message,
          existing.title,
          restorePayload,
          existing.pattern,
          existing.trigger_at,
          id,
        ],
      );

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

  // ─── Internal ──────────────────────────────────────────────────────────────

  private buildDynamicJobData(task: DynamicTask): TaskJobData {
    return {
      type: 'dynamic',
      task_id: task.id,
      kind: task.kind,
      message: task.message,
      title: task.title || undefined,
      payload: task.payload ? JSON.stringify(task.payload) : undefined,
    };
  }

  private normalizeDynamicTask(id: string, opts: DynamicTaskWriteOptions, createdAt: number): DynamicTask {
    if (!opts.pattern && !opts.triggerAt) {
      throw new Error('Must provide either pattern (cron) or triggerAt (one-shot)');
    }

    const kind: DynamicTaskKind = opts.kind || 'message';
    const payload = kind === 'workflow' ? normalizeWorkflowPayload(opts.payload) : null;
    const workflowSummary = payload ? summarizeWorkflowPayload(payload) : '';
    const message = kind === 'workflow'
      ? (opts.message.trim() || workflowSummary)
      : opts.message.trim();

    if (!message) {
      throw new Error('message 不能为空');
    }

    return {
      id,
      kind,
      message,
      title: opts.title || null,
      payload,
      pattern: opts.pattern || null,
      trigger_at: opts.triggerAt || null,
      status: 'active',
      created_at: createdAt,
    };
  }

  private insertDynamicTask(task: DynamicTask): void {
    this.db.run(
      `INSERT INTO dynamic_tasks (id, kind, message, title, payload, pattern, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.kind,
        task.message,
        task.title,
        task.payload ? JSON.stringify(task.payload) : null,
        task.pattern,
        task.trigger_at,
        task.status,
        task.created_at,
      ],
    );
  }

  private getRawDynamicTaskById(id: string): RawDynamicTask | null {
    return this.db.query('SELECT * FROM dynamic_tasks WHERE id = ?').get(id) as RawDynamicTask | null;
  }

  private deserializeDynamicTask(raw: RawDynamicTask): DynamicTask {
    let payload: WorkflowTaskPayload | null = null;
    if (raw.payload) {
      try {
        payload = normalizeWorkflowPayload(JSON.parse(raw.payload));
      } catch (error) {
        this.logger.warn(`dynamic task payload 解析失败: id=${raw.id}, error=${String(error)}`);
      }
    }
    return {
      ...raw,
      kind: (raw.kind || 'message') as DynamicTaskKind,
      payload,
    };
  }

  /** Reload active dynamic tasks from SQLite into bunqueue */
  private async reloadDynamicTasks(): Promise<void> {
    const rows = this.db.query(
      "SELECT * FROM dynamic_tasks WHERE status = 'active'",
    ).all() as RawDynamicTask[];

    const now = Date.now();
    let loaded = 0;

    for (const row of rows) {
      const task = this.deserializeDynamicTask(row);
      if (task.trigger_at && task.trigger_at <= now) {
        this.db.run("UPDATE dynamic_tasks SET status = 'completed' WHERE id = ?", [task.id]);
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
    const { type, task_id, kind, message, title, payload } = job.data;

    if (type === 'builtin') {
      const handler = this.builtinHandlers.get(task_id);
      if (!handler) {
        this.logger.warn(`内置任务 handler 未找到: ${task_id}`);
        return;
      }
      this.logger.info(`执行内置任务: ${task_id}`);
      const start = Date.now();
      try {
        await handler(this.ctx);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        this.logger.info(`任务完成: ${task_id} (${elapsed}s)`);
      } catch (err) {
        this.logger.error(`任务失败: ${task_id}`, err);
        throw err;
      }
      return;
    }

    const effectiveKind: DynamicTaskKind = kind || 'message';
    this.logger.info(`执行动态任务(${effectiveKind}): ${task_id}`);

    try {
      if (effectiveKind === 'agent') {
        await this.runAgentPrompt(message || '(空 prompt)', title);
        this.logger.info(`动态 agent 任务已完成: ${task_id}`);
      } else if (effectiveKind === 'workflow') {
        if (!payload) {
          throw new Error('workflow 任务缺少 payload');
        }
        const workflow = normalizeWorkflowPayload(JSON.parse(payload));
        await this.runWorkflow(task_id, workflow, title || undefined);
        this.logger.info(`动态 workflow 任务已完成: ${task_id}`);
      } else {
        if (!this.ctx.sendMessageToOwner) {
          this.logger.warn('sendMessageToOwner 未注入，跳过 message 类动态任务');
          return;
        }
        await this.ctx.sendMessageToOwner(message || '(空消息)');
        this.logger.info(`动态消息任务已发送: ${task_id}`);
      }
    } catch (err) {
      this.logger.error(`动态任务失败: ${task_id}`, err);
      throw err;
    }

    const task = this.getRawDynamicTaskById(task_id);
    if (task?.trigger_at) {
      this.db.run("UPDATE dynamic_tasks SET status = 'completed' WHERE id = ?", [task_id]);
      this.logger.info(`一次性任务已完成: ${task_id}`);
    }
  }

  private async runAgentPrompt(prompt: string, title?: string): Promise<void> {
    if (this.ctx.runAgentTask) {
      await this.ctx.runAgentTask(prompt, title);
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

    if (task.trigger_at) {
      const delay = task.trigger_at - Date.now();
      if (delay <= 0) {
        throw new Error('triggerAt must be in the future');
      }
      await this.queue.add('task', jobData, { delay, jobId: `dynamic:${task.id}` });
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
      { name: 'task', data: jobData },
    );
    this.logger.info(`注册周期任务(${task.kind}): ${task.id}, pattern=${task.pattern}`);
  }

  private async unregisterDynamicTask(task: Pick<DynamicTask, 'id' | 'pattern' | 'trigger_at'>): Promise<void> {
    if (task.pattern) {
      try { await this.queue.removeJobScheduler(`dynamic:${task.id}`); } catch { /* may not exist */ }
      return;
    }

    try { await this.queue.removeAsync(`dynamic:${task.id}`); } catch { /* may have fired */ }
  }

  private async runWorkflow(taskId: string, workflow: WorkflowTaskPayload, workflowTitle?: string): Promise<void> {
    const runDir = this.createWorkflowRunDir(taskId);
    const resultsFile = resolve(runDir, 'results.json');
    const results: WorkflowStepRunRecord[] = [];

    await Bun.write(
      resolve(runDir, 'workflow.json'),
      JSON.stringify({ taskId, title: workflowTitle || null, workflow }, null, 2),
    );

    for (let index = 0; index < workflow.steps.length; index++) {
      const step = workflow.steps[index];
      if (step.kind === 'shell') {
        const result = await this.runWorkflowShellStep(step, index, runDir);
        results.push(result);
      } else {
        const result = await this.runWorkflowAgentStep(taskId, step, index, runDir, results, workflowTitle);
        results.push(result);
      }

      await Bun.write(
        resultsFile,
        JSON.stringify(
          {
            taskId,
            title: workflowTitle || null,
            runDir,
            steps: results,
          },
          null,
          2,
        ),
      );
    }
  }

  private async runWorkflowShellStep(
    step: WorkflowShellStep,
    index: number,
    runDir: string,
  ): Promise<WorkflowStepRunRecord> {
    const outputDir = resolve(runDir, `${String(index + 1).padStart(2, '0')}-${sanitizePathSegment(step.id || step.kind)}`);
    mkdirSync(outputDir, { recursive: true });

    const startedAt = new Date();
    const cwd = this.resolveStepCwd(step.cwd);
    const timeoutSec = step.timeoutSec || DEFAULT_SHELL_TIMEOUT_SEC;
    const timeoutMs = timeoutSec * 1000;

    const proc = Bun.spawn(['/bin/zsh', '-lc', step.command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      proc.exited,
    ]);
    clearTimeout(timeoutHandle);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const stdoutPath = resolve(outputDir, 'stdout.txt');
    const stderrPath = resolve(outputDir, 'stderr.txt');
    const metaPath = resolve(outputDir, 'meta.json');

    await Promise.all([
      Bun.write(stdoutPath, stdout),
      Bun.write(stderrPath, stderr),
      Bun.write(
        metaPath,
        JSON.stringify(
          {
            stepId: step.id,
            kind: step.kind,
            command: step.command,
            cwd,
            timeoutSec,
            exitCode,
            timedOut,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs,
          },
          null,
          2,
        ),
      ),
    ]);

    const previewParts = [
      stdout.trim() ? `stdout (tail):\n${tailText(stdout.trim(), PREVIEW_CHAR_LIMIT)}` : '',
      stderr.trim() ? `stderr (tail):\n${tailText(stderr.trim(), PREVIEW_CHAR_LIMIT)}` : '',
    ].filter(Boolean);

    const result: WorkflowStepRunRecord = {
      stepId: step.id || `step_${index + 1}`,
      kind: 'shell',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      outputDir,
      command: step.command,
      cwd,
      timeoutSec,
      exitCode,
      timedOut,
      stdoutPath,
      stderrPath,
      preview: previewParts.join('\n\n'),
    };

    if (timedOut || exitCode !== 0) {
      const reason = timedOut
        ? `超时 (${timeoutSec}s)`
        : `exit=${exitCode}`;
      throw new Error(
        `workflow shell step 失败: step=${result.stepId}, reason=${reason}, stdout=${stdoutPath}, stderr=${stderrPath}`,
      );
    }

    return result;
  }

  private async runWorkflowAgentStep(
    taskId: string,
    step: WorkflowAgentStep,
    index: number,
    runDir: string,
    previousResults: WorkflowStepRunRecord[],
    workflowTitle?: string,
  ): Promise<WorkflowStepRunRecord> {
    const outputDir = resolve(runDir, `${String(index + 1).padStart(2, '0')}-${sanitizePathSegment(step.id || step.kind)}`);
    mkdirSync(outputDir, { recursive: true });

    const startedAt = new Date();
    const finalPrompt = this.buildWorkflowAgentPrompt(taskId, runDir, previousResults, step.prompt, workflowTitle);
    const promptPath = resolve(outputDir, 'prompt.md');
    await Bun.write(promptPath, finalPrompt);

    await this.runAgentPrompt(finalPrompt, step.title || workflowTitle || undefined);

    const finishedAt = new Date();
    return {
      stepId: step.id || `step_${index + 1}`,
      kind: 'agent',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      outputDir,
      title: step.title || workflowTitle || null,
      promptPath,
      preview: truncateText(step.prompt, PREVIEW_CHAR_LIMIT),
    };
  }

  private buildWorkflowAgentPrompt(
    taskId: string,
    runDir: string,
    previousResults: WorkflowStepRunRecord[],
    stepPrompt: string,
    workflowTitle?: string,
  ): string {
    const lines = [
      '[Workflow 上下文]',
      `- taskId: ${taskId}`,
      `- workflowTitle: ${workflowTitle || '(none)'}`,
      `- runDir: ${runDir}`,
      '- 这是 Sage scheduler 自动触发的 workflow。',
      '- 如果前置 shell step 已成功完成，不要重复运行这些 shell 命令；直接复用已有产物。',
      '- 如需详细内容，优先读取上面 runDir 中的文件，而不是重跑准备步骤。',
      '',
      '[前序步骤结果]',
    ];

    if (previousResults.length === 0) {
      lines.push('- (none)');
    } else {
      for (const result of previousResults) {
        lines.push(`- stepId: ${result.stepId}`);
        lines.push(`  kind: ${result.kind}`);
        lines.push(`  durationMs: ${result.durationMs}`);
        if (result.kind === 'shell') {
          if (result.command) lines.push(`  command: ${result.command}`);
          if (result.cwd) lines.push(`  cwd: ${result.cwd}`);
          if (typeof result.exitCode === 'number') lines.push(`  exitCode: ${result.exitCode}`);
          if (typeof result.timedOut === 'boolean') lines.push(`  timedOut: ${String(result.timedOut)}`);
          if (result.stdoutPath) lines.push(`  stdoutPath: ${result.stdoutPath}`);
          if (result.stderrPath) lines.push(`  stderrPath: ${result.stderrPath}`);
        } else {
          if (result.title) lines.push(`  title: ${result.title}`);
          if (result.promptPath) lines.push(`  promptPath: ${result.promptPath}`);
        }
        if (result.preview) {
          lines.push('  preview:');
          for (const previewLine of result.preview.split('\n')) {
            lines.push(`    ${previewLine}`);
          }
        }
      }
    }

    lines.push('');
    lines.push('[当前步骤要求]');
    lines.push(stepPrompt);
    return lines.join('\n');
  }

  private createWorkflowRunDir(taskId: string): string {
    const repoRoot = resolve(import.meta.dir, '../..');
    const root = resolve(repoRoot, 'agent_home/workspace/outputs/workflows');
    const runDir = resolve(root, taskId, formatRunTimestamp());
    mkdirSync(runDir, { recursive: true });
    return runDir;
  }

  private resolveStepCwd(stepCwd?: string | null): string {
    const expanded = expandHomeDir(stepCwd);
    if (!expanded) return process.cwd();
    if (expanded.startsWith('/')) return expanded;
    return resolve(process.cwd(), expanded);
  }
}
