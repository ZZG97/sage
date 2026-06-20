import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { runDatabaseMigrations } from '../../shared/db-migrations';
import type { Logger } from '../../utils';
import type { DynamicTask, DynamicTaskKind, DynamicTaskWriteOptions, RawDynamicTask, WorkflowTaskPayload } from './types';
import { normalizeDynamicTaskContext, normalizeWorkflowPayload, summarizeWorkflowPayload } from './workflow-normalizer';

export function buildDynamicTask(id: string, opts: DynamicTaskWriteOptions, createdAt: number): DynamicTask {
  if (!opts.pattern && !opts.triggerAt) {
    throw new Error('Must provide either pattern (cron) or triggerAt (one-shot)');
  }

  const kind: DynamicTaskKind = opts.kind || 'message';
  const payload = kind === 'workflow' ? normalizeWorkflowPayload(opts.payload) : null;
  const context = normalizeDynamicTaskContext(opts);
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
    context,
    pattern: opts.pattern || null,
    trigger_at: opts.triggerAt || null,
    status: 'active',
    created_at: createdAt,
  };
}

export class DynamicTaskRepository {
  static openDefault(isDev: boolean, logger: Logger): DynamicTaskRepository {
    const dbFile = isDev ? 'scheduler-dev.db' : 'scheduler.db';
    const dbPath = resolve(import.meta.dir, `../../../data/${dbFile}`);
    const db = new Database(dbPath, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    runDatabaseMigrations('scheduler', db, { logger });
    return new DynamicTaskRepository(db, logger);
  }

  constructor(
    private db: Database,
    private logger: Logger,
  ) {}

  insert(task: DynamicTask): void {
    this.db.run(
      `INSERT INTO dynamic_tasks (id, kind, message, title, payload, context_json, pattern, trigger_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.kind,
        task.message,
        task.title,
        task.payload ? JSON.stringify(task.payload) : null,
        task.context ? JSON.stringify(task.context) : null,
        task.pattern,
        task.trigger_at,
        task.status,
        task.created_at,
      ],
    );
  }

  list(includeCompleted = false): DynamicTask[] {
    const sql = includeCompleted
      ? 'SELECT * FROM dynamic_tasks ORDER BY created_at DESC'
      : "SELECT * FROM dynamic_tasks WHERE status = 'active' ORDER BY created_at DESC";
    const rows = this.db.query(sql).all() as RawDynamicTask[];
    return rows.map((row) => this.deserialize(row));
  }

  getById(id: string): DynamicTask | null {
    const raw = this.db.query('SELECT * FROM dynamic_tasks WHERE id = ?').get(id) as RawDynamicTask | null;
    return raw ? this.deserialize(raw) : null;
  }

  delete(id: string): void {
    this.db.run('DELETE FROM dynamic_tasks WHERE id = ?', [id]);
  }

  markCancelled(id: string): void {
    this.db.run("UPDATE dynamic_tasks SET status = 'cancelled' WHERE id = ?", [id]);
  }

  markCompleted(id: string): void {
    this.db.run("UPDATE dynamic_tasks SET status = 'completed' WHERE id = ?", [id]);
  }

  updateTask(task: DynamicTask): void {
    this.db.run(
      `UPDATE dynamic_tasks
       SET kind = ?, message = ?, title = ?, payload = ?, context_json = ?, pattern = ?, trigger_at = ?
       WHERE id = ?`,
      [
        task.kind,
        task.message,
        task.title,
        task.payload ? JSON.stringify(task.payload) : null,
        task.context ? JSON.stringify(task.context) : null,
        task.pattern,
        task.trigger_at,
        task.id,
      ],
    );
  }

  close(): void {
    this.db.close();
  }

  private deserialize(raw: RawDynamicTask): DynamicTask {
    let payload: WorkflowTaskPayload | null = null;
    if (raw.payload) {
      try {
        payload = normalizeWorkflowPayload(JSON.parse(raw.payload));
      } catch (error) {
        this.logger.warn(`dynamic task payload 解析失败: id=${raw.id}, error=${String(error)}`);
      }
    }

    let context = null;
    if (raw.context_json) {
      try {
        const parsed = JSON.parse(raw.context_json) as { reuseConversationId?: unknown };
        context = parsed?.reuseConversationId ? { reuseConversationId: String(parsed.reuseConversationId) } : null;
      } catch (error) {
        this.logger.warn(`dynamic task context 解析失败: id=${raw.id}, error=${String(error)}`);
      }
    }

    return {
      ...raw,
      kind: (raw.kind || 'message') as DynamicTaskKind,
      payload,
      context,
    };
  }
}
