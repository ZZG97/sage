// TaskScheduler — bunqueue-based task scheduler with dynamic task support
// Replaces the old setInterval-based Scheduler
import { Queue, Worker } from 'bunqueue/client';
import { Database } from 'bun:sqlite';
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

/** A dynamic scheduled task stored in SQLite */
export interface DynamicTask {
  id: string;
  /** 'message' = 到点发一条纯文本；'agent' = 到点触发 agent 对话并渲染成流式卡片 */
  kind: 'message' | 'agent';
  /** kind='message' 时：要发送的文本；kind='agent' 时：作为 agent 的 prompt */
  message: string;
  /** kind='agent' 时：主动任务根消息标题 */
  title: string | null;
  /** Cron pattern (recurring) OR null for one-shot */
  pattern: string | null;
  /** Epoch ms for one-shot trigger time */
  trigger_at: number | null;
  /** active / completed / cancelled */
  status: string;
  created_at: number;
}

/** Job data flowing through bunqueue */
interface TaskJobData {
  type: 'builtin' | 'dynamic';
  /** For builtin: task name; for dynamic: task id */
  task_id: string;
  /** For dynamic: kind */
  kind?: 'message' | 'agent';
  /** For dynamic: payload — text for 'message', prompt for 'agent' */
  message?: string;
  /** For dynamic agent: proactive topic text */
  title?: string;
}

const QUEUE_NAME = 'sage:tasks';
const TIMEZONE = 'Asia/Shanghai';

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

    // Init bunqueue
    this.queue = new Queue<TaskJobData>(QUEUE_NAME, {
      embedded: true,
    });
    this.queue.setStallConfig({ enabled: false });

    // Init SQLite for dynamic tasks (dev uses separate DB to avoid cross-firing)
    const dbFile = isDev ? 'scheduler-dev.db' : 'scheduler.db';
    const dbPath = resolve(import.meta.dir, `../../data/${dbFile}`);
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dynamic_tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        title TEXT,
        pattern TEXT,
        trigger_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      )
    `);
    // Migration: 加 kind 字段（默认 'message'，兼容老数据）
    const cols = this.db.query(`PRAGMA table_info(dynamic_tasks)`).all() as Array<{ name: string }>;
    const hasKind = cols.some(c => c.name === 'kind');
    if (!hasKind) {
      this.db.exec(`ALTER TABLE dynamic_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'message'`);
      this.logger.info('dynamic_tasks 表迁移：新增 kind 字段');
    }
    const hasTitle = cols.some(c => c.name === 'title');
    if (!hasTitle) {
      this.db.exec(`ALTER TABLE dynamic_tasks ADD COLUMN title TEXT`);
      this.logger.info('dynamic_tasks 表迁移：新增 title 字段');
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
    // 1. Register built-in cron tasks
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

    // 2. Reload dynamic tasks from DB
    await this.reloadDynamicTasks();

    // 3. Start worker
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
  async createDynamicTask(opts: {
    /** 任务类型：message=纯文本提醒，agent=触发 agent 对话 */
    kind?: 'message' | 'agent';
    /** kind='message' 时作为文本内容；kind='agent' 时作为 prompt */
    message: string;
    /** kind='agent' 时作为主动任务根消息标题 */
    title?: string;
    /** Cron pattern for recurring, e.g. "30 9 * * 1-5" */
    pattern?: string;
    /** Epoch ms for one-shot trigger */
    triggerAt?: number;
  }): Promise<DynamicTask> {
    if (!opts.pattern && !opts.triggerAt) {
      throw new Error('Must provide either pattern (cron) or triggerAt (one-shot)');
    }

    const kind: 'message' | 'agent' = opts.kind || 'message';
    const id = crypto.randomUUID();
    const now = Date.now();
    const task: DynamicTask = {
      id,
      kind,
      message: opts.message,
      title: opts.title || null,
      pattern: opts.pattern || null,
      trigger_at: opts.triggerAt || null,
      status: 'active',
      created_at: now,
    };

    // Persist to DB
    this.db.run(
      `INSERT INTO dynamic_tasks (id, kind, message, title, pattern, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.kind, task.message, task.title, task.pattern, task.trigger_at, task.status, task.created_at],
    );

    // Register with bunqueue
    const jobData: TaskJobData = { type: 'dynamic', task_id: id, kind, message: opts.message, title: opts.title };

    if (opts.triggerAt) {
      const delay = opts.triggerAt - now;
      if (delay <= 0) {
        throw new Error('triggerAt must be in the future');
      }
      await this.queue.add('task', jobData, { delay, jobId: `dynamic:${id}` });
      this.logger.info(`创建一次性任务(${kind}): ${id}, 将在 ${new Date(opts.triggerAt).toLocaleString('zh-CN', { timeZone: TIMEZONE })} 触发`);
    } else if (opts.pattern) {
      await this.queue.upsertJobScheduler(
        `dynamic:${id}`,
        { pattern: opts.pattern, timezone: TIMEZONE },
        { name: 'task', data: jobData },
      );
      this.logger.info(`创建周期任务(${kind}): ${id}, pattern=${opts.pattern}`);
    }

    return task;
  }

  /** List all dynamic tasks */
  listDynamicTasks(includeCompleted = false): DynamicTask[] {
    if (includeCompleted) {
      return this.db.query('SELECT * FROM dynamic_tasks ORDER BY created_at DESC').all() as DynamicTask[];
    }
    return this.db.query(
      "SELECT * FROM dynamic_tasks WHERE status = 'active' ORDER BY created_at DESC",
    ).all() as DynamicTask[];
  }

  /** List registered built-in tasks */
  listBuiltinTasks(): BuiltinTaskSummary[] {
    return Array.from(this.builtinDefs.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Remove a dynamic task */
  async removeDynamicTask(id: string): Promise<boolean> {
    const task = this.db.query('SELECT * FROM dynamic_tasks WHERE id = ?').get(id) as DynamicTask | null;
    if (!task) return false;

    // Remove from bunqueue
    if (task.pattern) {
      try { await this.queue.removeJobScheduler(`dynamic:${id}`); } catch { /* may not exist */ }
    } else {
      try { await this.queue.removeAsync(`dynamic:${id}`); } catch { /* may have fired */ }
    }

    // Update DB
    this.db.run("UPDATE dynamic_tasks SET status = 'cancelled' WHERE id = ?", [id]);
    this.logger.info(`删除动态任务: ${id}`);
    return true;
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

  /** Reload active dynamic tasks from SQLite into bunqueue */
  private async reloadDynamicTasks(): Promise<void> {
    const tasks = this.db.query(
      "SELECT * FROM dynamic_tasks WHERE status = 'active'",
    ).all() as DynamicTask[];

    const now = Date.now();
    let loaded = 0;

    for (const task of tasks) {
      const jobData: TaskJobData = {
        type: 'dynamic',
        task_id: task.id,
        kind: task.kind || 'message',
        message: task.message,
        title: task.title || undefined,
      };

      if (task.trigger_at) {
        if (task.trigger_at <= now) {
          // Expired one-shot — mark completed
          this.db.run("UPDATE dynamic_tasks SET status = 'completed' WHERE id = ?", [task.id]);
          continue;
        }
        const delay = task.trigger_at - now;
        await this.queue.add('task', jobData, { delay, jobId: `dynamic:${task.id}` });
      } else if (task.pattern) {
        await this.queue.upsertJobScheduler(
          `dynamic:${task.id}`,
          { pattern: task.pattern, timezone: TIMEZONE },
          { name: 'task', data: jobData },
        );
      }
      loaded++;
    }

    if (loaded > 0) {
      this.logger.info(`恢复 ${loaded} 个动态任务`);
    }
  }

  /** Process a job from the queue */
  private async processJob(job: { data: TaskJobData }): Promise<void> {
    const { type, task_id, kind, message, title } = job.data;

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
    } else if (type === 'dynamic') {
      const effectiveKind = kind || 'message';
      this.logger.info(`执行动态任务(${effectiveKind}): ${task_id}`);

      try {
        if (effectiveKind === 'agent') {
          if (!this.ctx.runAgentTask) {
            this.logger.warn('runAgentTask 未注入，跳过 agent 类动态任务');
            return;
          }
          await this.ctx.runAgentTask(message || '(空 prompt)', title);
          this.logger.info(`动态 agent 任务已完成: ${task_id}`);
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

      // Check if one-shot → mark completed
      const task = this.db.query('SELECT * FROM dynamic_tasks WHERE id = ?').get(task_id) as DynamicTask | null;
      if (task?.trigger_at) {
        this.db.run("UPDATE dynamic_tasks SET status = 'completed' WHERE id = ?", [task_id]);
        this.logger.info(`一次性任务已完成: ${task_id}`);
      }
    }
  }
}
