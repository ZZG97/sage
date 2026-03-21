// 对话历史持久化 — SQLite
import { Database } from 'bun:sqlite';
import { Logger } from '../utils';
import type { AgentEvent } from '../agent/types';
import { join } from 'path';

export class HistoryStore {
  private db: Database;
  private logger: Logger;
  private env: string;

  constructor(dbPath: string, env: string = 'production') {
    this.logger = new Logger('HistoryStore');
    this.env = env;
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.initSchema();
    this.logger.info(`对话历史数据库已打开: ${dbPath}`);
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
    `);
  }

  /** 确保 session 存在，不存在则创建 */
  ensureSession(sessionId: string, provider: string, ctx?: { openId?: string; chatId?: string; chatType?: string }): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, env, provider, open_id, chat_id, chat_type, started_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_active_at = ?`,
      [sessionId, this.env, provider, ctx?.openId ?? null, ctx?.chatId ?? null, ctx?.chatType ?? null, now, now, now]
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
  saveUserMessage(sessionId: string, provider: string, text: string, ctx?: { openId?: string; chatId?: string; chatType?: string }): void {
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

  /** 搜索历史（全文搜 content） */
  searchHistory(keyword: string, limit: number = 50): any[] {
    return this.db.query(
      `SELECT e.*, s.summary FROM events e
       LEFT JOIN sessions s ON e.session_id = s.id
       WHERE e.content LIKE ?
       ORDER BY e.ts DESC LIMIT ?`
    ).all(`%${keyword}%`, limit);
  }

  /** 获取最近的 sessions */
  getRecentSessions(limit: number = 20): any[] {
    return this.db.query(
      `SELECT * FROM sessions ORDER BY last_active_at DESC LIMIT ?`
    ).all(limit);
  }

  destroy(): void {
    this.db.close();
    this.logger.info('对话历史数据库已关闭');
  }
}
