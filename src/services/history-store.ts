// 对话历史持久化 — SQLite
import { Database } from 'bun:sqlite';
import { Logger } from '../utils';
import type { AgentEvent } from '../agent/types';
import { join, resolve } from 'path';

// 默认 db 路径: {项目根}/data/history.db
const DEFAULT_DB_PATH = resolve(import.meta.dir, '../../data/history.db');

export interface SessionWithEvents {
  id: string;
  provider: string;
  open_id: string | null;
  chat_id: string | null;
  chat_type: string | null;
  started_at: string;
  last_active_at: string;
  summary: string | null;
  events: Array<{
    role: string;
    type: string;
    position: number;
    content: string | null;
    tool_name: string | null;
    ts: string;
  }>;
}

/** 从 IANA 时区名计算 SQLite 用的 UTC 偏移修饰符，如 '${this.tzModifier}'、'-5 hours' */
function sqliteTimezoneModifier(tz?: string): string {
  const timeZone = tz || process.env.TZ || 'Asia/Shanghai';
  // 用 Intl 取当前 UTC 偏移（分钟）
  const now = new Date();
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const localStr = now.toLocaleString('en-US', { timeZone });
  const diffMs = new Date(localStr).getTime() - new Date(utcStr).getTime();
  const diffHours = Math.round(diffMs / 3600000);
  const sign = diffHours >= 0 ? '+' : '';
  return `${sign}${diffHours} hours`;
}

export class HistoryStore {
  private db: Database;
  private logger: Logger;
  private env: string;
  private tzModifier: string;

  constructor(dbPath?: string, env: string = 'production', timezone?: string) {
    this.logger = new Logger('HistoryStore');
    this.env = env;
    this.tzModifier = sqliteTimezoneModifier(timezone);
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH;
    this.db = new Database(resolvedPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.initSchema();
    this.logger.info(`对话历史数据库已打开: ${resolvedPath}`);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        env TEXT NOT NULL DEFAULT 'production',
        provider TEXT NOT NULL,
        open_id TEXT,
        chat_id TEXT,
        chat_type TEXT,
        started_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        summary TEXT,
        keywords TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        content TEXT,
        tool_name TEXT,
        tool_detail TEXT,
        ts TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

      CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    // Migration: 新增 thread_key 和 resume_id 列
    this.migrateAddColumns();
  }

  /** 增量 migration：为 sessions 表添加 agent_session_id / resume_id 列 */
  private migrateAddColumns(): void {
    const cols = this.db.query(`PRAGMA table_info(sessions)`).all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));

    if (!colNames.has('agent_session_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN agent_session_id TEXT`);
      this.logger.info('Migration: 添加 agent_session_id 列');
    }
    if (!colNames.has('resume_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN resume_id TEXT`);
      this.logger.info('Migration: 添加 resume_id 列');
    }
  }

  /** 确保 session 存在，不存在则创建。sessionId 此处即 threadKey（DB 主键） */
  ensureSession(sessionId: string, provider: string, ctx?: { openId?: string; chatId?: string; chatType?: string; agentSessionId?: string }): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, env, provider, open_id, chat_id, chat_type, agent_session_id, started_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_active_at = ?,
         agent_session_id = COALESCE(excluded.agent_session_id, sessions.agent_session_id)`,
      [sessionId, this.env, provider, ctx?.openId ?? null, ctx?.chatId ?? null, ctx?.chatType ?? null, ctx?.agentSessionId ?? null, now, now, now]
    );
  }

  /** 更新 session 最后活跃时间 */
  touchSession(sessionId: string): void {
    this.db.run(
      `UPDATE sessions SET last_active_at = ? WHERE id = ?`,
      [new Date().toISOString(), sessionId]
    );
  }

  /** 获取某 session 下一个 position */
  private nextPosition(sessionId: string): number {
    const row = this.db.query(
      `SELECT COALESCE(MAX(position), -1) + 1 AS next FROM events WHERE session_id = ?`
    ).get(sessionId) as { next: number } | null;
    return row?.next ?? 0;
  }

  /** 写入用户消息 */
  saveUserMessage(sessionId: string, provider: string, text: string, ctx?: { openId?: string; chatId?: string; chatType?: string; agentSessionId?: string }): void {
    this.ensureSession(sessionId, provider, ctx);
    const pos = this.nextPosition(sessionId);
    this.db.run(
      `INSERT INTO events (session_id, provider, role, type, position, content, ts)
       VALUES (?, ?, 'user', 'text', ?, ?, ?)`,
      [sessionId, provider, pos, text, new Date().toISOString()]
    );
  }

  /** 写入 agent 事件（仅 persist=true 的） */
  saveAgentEvents(sessionId: string, provider: string, events: AgentEvent[]): void {
    let pos = this.nextPosition(sessionId);
    const stmt = this.db.prepare(
      `INSERT INTO events (session_id, provider, role, type, position, content, tool_name, tool_detail, ts)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?)`
    );

    for (const ev of events) {
      if (!ev.persist) continue;
      stmt.run(
        sessionId, provider, ev.type, pos,
        ev.content ?? null, ev.toolName ?? null, ev.toolDetail ?? null, ev.ts
      );
      pos++;
    }

    this.touchSession(sessionId);
  }

  /** 更新 session 的 resume_id（SDK 级别的 resume ID） */
  updateResumeId(threadKey: string, resumeId: string): void {
    this.db.run(
      `UPDATE sessions SET resume_id = ? WHERE id = ?`,
      [resumeId, threadKey]
    );
  }

  /** 更新 session 的 agent_session_id */
  updateAgentSessionId(threadKey: string, agentSessionId: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_id = ? WHERE id = ?`,
      [agentSessionId, threadKey]
    );
  }

  /** 获取活跃 sessions（用于启动恢复）。id 即 threadKey */
  getActiveSessionsForRestore(maxAgeMs: number): Array<{
    id: string;             // threadKey
    agent_session_id: string; // provider session id (cc-xxx)
    resume_id: string;      // SDK resume id
    provider: string;
    open_id: string;
    last_active_at: string;
  }> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.query(
      `SELECT id, agent_session_id, resume_id, provider, open_id, last_active_at
       FROM sessions
       WHERE env = ? AND agent_session_id IS NOT NULL AND last_active_at > ?
       ORDER BY last_active_at DESC`
    ).all(this.env, cutoff) as any[];
  }

  /** 按 threadKey 查询 session（返回 null 表示不存在） */
  getSession(threadKey: string): {
    id: string;
    agent_session_id: string | null;
    resume_id: string | null;
    provider: string;
    open_id: string | null;
    last_active_at: string;
  } | null {
    return this.db.query(
      `SELECT id, agent_session_id, resume_id, provider, open_id, last_active_at
       FROM sessions WHERE id = ? AND env = ?`
    ).get(threadKey, this.env) as any ?? null;
  }

  /** 清除 session 的 agent 关联（/clear 用） */
  clearSessionAgent(threadKey: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_id = NULL, resume_id = NULL WHERE id = ?`,
      [threadKey]
    );
  }

  /** 迁移 session_id（飞书 thread 创建时，msg:xxx → thread_id） */
  migrateSessionId(oldId: string, newId: string): void {
    this.db.run(`UPDATE events SET session_id = ? WHERE session_id = ?`, [newId, oldId]);
    this.db.run(`UPDATE sessions SET id = ? WHERE id = ?`, [newId, oldId]);
    this.logger.info(`历史记录 session 迁移: ${oldId} -> ${newId}`);
  }

  /** 查询某 session 的全部事件 */
  getSessionEvents(sessionId: string): any[] {
    return this.db.query(
      `SELECT * FROM events WHERE session_id = ? ORDER BY position`
    ).all(sessionId);
  }

  /** 按日期查询 sessions + events */
  getSessionsForDate(date: string): SessionWithEvents[] {
    const sessions = this.db.query(
      `SELECT * FROM sessions WHERE env = ? AND date(started_at, '${this.tzModifier}') = ? ORDER BY started_at ASC`
    ).all(this.env, date) as any[];

    return this.attachEvents(sessions);
  }

  /** 按日期范围查询 sessions + events */
  getSessionsByDateRange(startDate: string, endDate: string): SessionWithEvents[] {
    const sessions = this.db.query(
      `SELECT * FROM sessions WHERE env = ? AND date(started_at, '${this.tzModifier}') >= ? AND date(started_at, '${this.tzModifier}') <= ? ORDER BY started_at ASC`
    ).all(this.env, startDate, endDate) as any[];

    return this.attachEvents(sessions);
  }

  /** 为 sessions 填充 events */
  private attachEvents(sessions: any[]): SessionWithEvents[] {
    if (sessions.length === 0) return [];

    const eventStmt = this.db.prepare(
      `SELECT role, type, position, content, tool_name, ts FROM events WHERE session_id = ? ORDER BY position`
    );

    return sessions.map(s => ({
      id: s.id,
      provider: s.provider,
      open_id: s.open_id,
      chat_id: s.chat_id,
      chat_type: s.chat_type,
      started_at: s.started_at,
      last_active_at: s.last_active_at,
      summary: s.summary,
      events: eventStmt.all(s.id) as SessionWithEvents['events'],
    }));
  }

  /** 获取某 session 最近 N 轮 user/assistant 文本对话（用于 fallback 上下文注入） */
  getRecentConversation(sessionId: string, maxTurns: number = 5): Array<{ role: string; content: string }> {
    const rows = this.db.query(
      `SELECT role, content FROM events
       WHERE session_id = ? AND type = 'text' AND content IS NOT NULL AND content != ''
       ORDER BY position DESC
       LIMIT ?`
    ).all(sessionId, maxTurns * 2) as Array<{ role: string; content: string }>;

    // 反转回正序，并截取最近 maxTurns 轮（每轮 = 1 user + 1 assistant）
    rows.reverse();

    // 取最后 maxTurns * 2 条（已经是了），但按轮次截断：从第一条 user 消息开始
    const firstUserIdx = rows.findIndex(r => r.role === 'user');
    if (firstUserIdx > 0) rows.splice(0, firstUserIdx);

    // 截断 content 避免 token 过长
    return rows.map(r => ({
      role: r.role,
      content: r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content,
    }));
  }

  /** 搜索历史（全文搜 content） */
  searchHistory(keyword: string, limit: number = 50): any[] {
    return this.db.query(
      `SELECT e.*, s.summary FROM events e
       LEFT JOIN sessions s ON e.session_id = s.id
       WHERE e.content LIKE ?
       ORDER BY e.ts DESC LIMIT ?`
    ).all(`%${keyword}%`, limit);
  }

  /** 按 session_id 前缀模糊匹配 */
  findSessionsByPrefix(prefix: string): any[] {
    return this.db.query(
      `SELECT * FROM sessions WHERE id LIKE ? ORDER BY last_active_at DESC LIMIT 10`
    ).all(`${prefix}%`);
  }

  /** 获取最近的 sessions */
  getRecentSessions(limit: number = 20): any[] {
    return this.db.query(
      `SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?`
    ).all(limit);
  }

  /** 检查飞书事件是否已处理过（原子操作：查+写） */
  isDuplicateEvent(eventId: string): boolean {
    const result = this.db.run(
      'INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)',
      [eventId]
    );
    return result.changes === 0;
  }

  /** 清理过期的已处理事件记录 */
  cleanupProcessedEvents(maxAgeSeconds: number = 86400): void {
    const result = this.db.run(
      'DELETE FROM processed_events WHERE created_at < unixepoch() - ?',
      [maxAgeSeconds]
    );
    if (result.changes > 0) {
      this.logger.info(`清理过期事件记录: ${result.changes} 条`);
    }
  }

  destroy(): void {
    this.db.close();
    this.logger.info('对话历史数据库已关闭');
  }
}
