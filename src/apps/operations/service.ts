import { getDatabase } from '../../shared/db';
import { runDatabaseMigrations } from '../../shared/db-migrations';
import { createRequestId, getRequestContext, Logger, sanitizeLogValue } from '../../utils';

export type OperationStatus = 'running' | 'success' | 'warning' | 'failed' | 'cancelled';
export type OperationTrigger = 'scheduler' | 'feishu' | 'http' | 'manual';

export interface OperationRun {
  id: string;
  operation_type: string;
  operation_name: string;
  trigger_type: OperationTrigger;
  status: OperationStatus;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  summary: string | null;
  metrics: Record<string, number | string | boolean | null>;
  error: string | null;
  metadata: Record<string, unknown>;
  request_id: string | null;
  trace_id: string | null;
  alerted_at: number | null;
}

export interface StartOperationRunOptions {
  operationType: string;
  operationName?: string;
  triggerType?: OperationTrigger;
  metadata?: Record<string, unknown>;
}

export interface FinishOperationRunOptions {
  status?: Exclude<OperationStatus, 'running'>;
  summary?: string;
  metrics?: Record<string, number | string | boolean | null>;
  error?: unknown;
}

interface OperationRunRow extends Omit<OperationRun, 'metrics' | 'metadata'> {
  metrics_json: string;
  metadata_json: string;
}

const logger = new Logger('Operations');
let singleton: OperationsService | null = null;

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function inferTriggerType(): OperationTrigger {
  const source = getRequestContext()?.source;
  if (source === 'scheduler' || source === 'feishu' || source === 'http') return source;
  return 'manual';
}

function normalizeError(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) {
    return sanitizeLogValue(error.stack || `${error.name}: ${error.message}`, 4000);
  }
  return sanitizeLogValue(error, 4000);
}

function toRun(row: OperationRunRow): OperationRun {
  const { metrics_json, metadata_json, ...rest } = row;
  return {
    ...rest,
    metrics: parseJsonObject(metrics_json) as OperationRun['metrics'],
    metadata: parseJsonObject(metadata_json),
  };
}

export class OperationRunHandle {
  private metrics: Record<string, number | string | boolean | null> = {};
  private warnings: string[] = [];
  private finished = false;

  constructor(
    private service: OperationsService,
    public readonly id: string,
  ) {}

  metric(key: string, value: number | string | boolean | null): void {
    this.metrics[key] = value;
  }

  addMetrics(metrics: Record<string, number | string | boolean | null>): void {
    Object.assign(this.metrics, metrics);
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  success(options: Omit<FinishOperationRunOptions, 'status' | 'error'> = {}): void {
    const summary = [options.summary, ...this.warnings].filter(Boolean).join('; ') || options.summary;
    this.finish({
      ...options,
      summary,
      status: this.warnings.length > 0 ? 'warning' : 'success',
    });
  }

  failure(error: unknown, options: Omit<FinishOperationRunOptions, 'status' | 'error'> = {}): void {
    this.finish({
      ...options,
      status: 'failed',
      error,
      summary: options.summary || normalizeError(error) || 'operation failed',
    });
  }

  finish(options: FinishOperationRunOptions): void {
    if (this.finished) return;
    this.finished = true;
    this.service.finishRun(this.id, {
      ...options,
      metrics: { ...this.metrics, ...options.metrics },
    });
  }
}

export class OperationsService {
  private db = getDatabase('operations');

  constructor() {
    runDatabaseMigrations('operations', this.db, { logger });
  }

  startRun(options: StartOperationRunOptions): OperationRunHandle {
    const now = Date.now();
    const ctx = getRequestContext();
    const id = createRequestId('op');
    const operationName = options.operationName || options.operationType;

    this.db.prepare(`
      INSERT INTO operation_runs (
        id, operation_type, operation_name, trigger_type, status,
        started_at, metadata_json, request_id, trace_id
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id,
      options.operationType,
      operationName,
      options.triggerType || inferTriggerType(),
      now,
      JSON.stringify(options.metadata || {}),
      ctx?.requestId ?? null,
      ctx?.runId ?? null,
    );

    return new OperationRunHandle(this, id);
  }

  finishRun(id: string, options: FinishOperationRunOptions): void {
    const row = this.db.prepare('SELECT started_at FROM operation_runs WHERE id = ?').get(id) as { started_at: number } | null;
    if (!row) {
      logger.warn(`operation run not found: ${id}`);
      return;
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - row.started_at;
    const status = options.status || 'success';
    const error = normalizeError(options.error);

    this.db.prepare(`
      UPDATE operation_runs
      SET status = ?,
          finished_at = ?,
          duration_ms = ?,
          summary = ?,
          metrics_json = ?,
          error = ?
      WHERE id = ?
    `).run(
      status,
      finishedAt,
      durationMs,
      options.summary ?? null,
      JSON.stringify(options.metrics || {}),
      error,
      id,
    );
  }

  listRuns(options: { limit?: number; status?: OperationStatus; operationType?: string } = {}): OperationRun[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (options.status) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.operationType) {
      where.push('operation_type = ?');
      params.push(options.operationType);
    }

    const sql = `
      SELECT * FROM operation_runs
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY started_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, limit) as OperationRunRow[];
    return rows.map(toRun);
  }

  getSummary(sinceMs = 24 * 60 * 60 * 1000): {
    since: number;
    total: number;
    running: number;
    success: number;
    warning: number;
    failed: number;
    cancelled: number;
  } {
    const since = Date.now() - sinceMs;
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM operation_runs
      WHERE started_at >= ?
      GROUP BY status
    `).all(since) as Array<{ status: OperationStatus; count: number }>;

    const summary = {
      since,
      total: 0,
      running: 0,
      success: 0,
      warning: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) {
      summary[row.status] = row.count;
      summary.total += row.count;
    }
    return summary;
  }

  listUnalertedProblemRuns(limit = 10): OperationRun[] {
    const rows = this.db.prepare(`
      SELECT *
      FROM operation_runs
      WHERE status IN ('failed', 'warning')
        AND alerted_at IS NULL
      ORDER BY finished_at ASC
      LIMIT ?
    `).all(limit) as OperationRunRow[];
    return rows.map(toRun);
  }

  listStuckRuns(maxAgeMs: number, limit = 10): OperationRun[] {
    const startedBefore = Date.now() - maxAgeMs;
    const rows = this.db.prepare(`
      SELECT *
      FROM operation_runs
      WHERE status = 'running'
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT ?
    `).all(startedBefore, limit) as OperationRunRow[];
    return rows.map(toRun);
  }

  markRunsAlerted(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE operation_runs SET alerted_at = ? WHERE id = ?');
    const now = Date.now();
    const tx = this.db.transaction((runIds: string[]) => {
      for (const id of runIds) stmt.run(now, id);
    });
    tx(ids);
  }

  getLastRun(operationType: string, operationName?: string): OperationRun | null {
    const row = operationName
      ? this.db.prepare(`
          SELECT * FROM operation_runs
          WHERE operation_type = ? AND operation_name = ?
          ORDER BY started_at DESC
          LIMIT 1
        `).get(operationType, operationName) as OperationRunRow | null
      : this.db.prepare(`
          SELECT * FROM operation_runs
          WHERE operation_type = ?
          ORDER BY started_at DESC
          LIMIT 1
        `).get(operationType) as OperationRunRow | null;
    return row ? toRun(row) : null;
  }

  getLastSuccessfulRun(operationType: string, operationName?: string): OperationRun | null {
    const row = operationName
      ? this.db.prepare(`
          SELECT * FROM operation_runs
          WHERE operation_type = ? AND operation_name = ? AND status = 'success'
          ORDER BY finished_at DESC
          LIMIT 1
        `).get(operationType, operationName) as OperationRunRow | null
      : this.db.prepare(`
          SELECT * FROM operation_runs
          WHERE operation_type = ? AND status = 'success'
          ORDER BY finished_at DESC
          LIMIT 1
        `).get(operationType) as OperationRunRow | null;
    return row ? toRun(row) : null;
  }

  shouldSendAlert(alertKey: string, minIntervalMs: number): boolean {
    const now = Date.now();
    const row = this.db.prepare(`
      SELECT last_alerted_at FROM operation_health_alerts WHERE alert_key = ?
    `).get(alertKey) as { last_alerted_at: number } | null;

    if (row && now - row.last_alerted_at < minIntervalMs) {
      return false;
    }

    this.db.prepare(`
      INSERT INTO operation_health_alerts (alert_key, last_alerted_at)
      VALUES (?, ?)
      ON CONFLICT(alert_key) DO UPDATE SET last_alerted_at = excluded.last_alerted_at
    `).run(alertKey, now);
    return true;
  }

}

export function getOperationsService(): OperationsService {
  if (!singleton) {
    singleton = new OperationsService();
  }
  return singleton;
}
