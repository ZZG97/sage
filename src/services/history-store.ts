// 对话历史持久化 — SQLite
import { Database } from 'bun:sqlite';
import { Logger } from '../utils';
import type { AgentEvent } from '../agent/types';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { runDatabaseMigrations, runHistoryDataMigrations } from '../shared/db-migrations';

// 默认 db 路径: {项目根}/data/history.db
const DEFAULT_DB_PATH = resolve(import.meta.dir, '../../data/history.db');
const DEFAULT_DEV_DB_PATH = resolve(import.meta.dir, '../../data/history-dev.db');

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

export interface ConversationSession {
  id: string;
  first_message_id: string | null;
  thread_id: string | null;
  agent_session_id: string | null;
  agent_session_provider: string | null;
  resume_id: string | null;
  provider: string;
  open_id: string | null;
  chat_id: string | null;
  chat_type: string | null;
  last_active_at: string;
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
    const resolvedPath = dbPath ?? (env === 'dev' ? DEFAULT_DEV_DB_PATH : DEFAULT_DB_PATH);
    this.db = new Database(resolvedPath, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    runDatabaseMigrations('history', this.db, { logger: this.logger });
    runHistoryDataMigrations(this.db, {
      env: this.env,
      enabled: process.env.RUN_HISTORY_DATA_MIGRATIONS === '1',
      logger: this.logger,
    });
    this.logger.info(`对话历史数据库已打开: ${resolvedPath}`);
  }

  private newConversationId(): string {
    return `conv_${randomUUID()}`;
  }

  /** 创建一条 Sage 内部 conversation。message/thread 是外部字段，不作为主键。 */
  createConversation(provider: string, ctx?: {
    firstMessageId?: string;
    threadId?: string;
    openId?: string;
    chatId?: string;
    chatType?: string;
    agentSessionId?: string;
    agentSessionProvider?: string;
  }): string {
    const now = new Date().toISOString();
    const id = this.newConversationId();
    this.db.run(
      `INSERT INTO sessions (
         id, env, provider, open_id, chat_id, chat_type,
         first_message_id, thread_id, agent_session_id, agent_session_provider,
         started_at, last_active_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, this.env, provider,
        ctx?.openId ?? null,
        ctx?.chatId ?? null,
        ctx?.chatType ?? null,
        ctx?.firstMessageId ?? null,
        ctx?.threadId ?? null,
        ctx?.agentSessionId ?? null,
        ctx?.agentSessionProvider ?? null,
        now, now,
      ],
    );
    return id;
  }

  /** 确保 conversation 存在，不存在则按给定 id 创建。仅兼容旧调用路径。 */
  ensureSession(sessionId: string, provider: string, ctx?: { openId?: string; chatId?: string; chatType?: string; agentSessionId?: string; agentSessionProvider?: string }): void {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, env, provider, open_id, chat_id, chat_type, agent_session_id, agent_session_provider, started_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_active_at = ?,
         agent_session_id = COALESCE(excluded.agent_session_id, sessions.agent_session_id),
         agent_session_provider = COALESCE(excluded.agent_session_provider, sessions.agent_session_provider)`,
      [sessionId, this.env, provider, ctx?.openId ?? null, ctx?.chatId ?? null, ctx?.chatType ?? null, ctx?.agentSessionId ?? null, ctx?.agentSessionProvider ?? null, now, now, now]
    );
  }

  /** 给 conversation 补充/更新飞书 thread_id。 */
  setConversationThreadId(conversationId: string, threadId: string): void {
    this.db.run(
      `UPDATE sessions SET thread_id = ?, last_active_at = ? WHERE id = ? AND env = ?`,
      [threadId, new Date().toISOString(), conversationId, this.env],
    );
  }

  /** 给 conversation 绑定首条飞书消息 id。主动卡片发送后才拿得到 message_id。 */
  setConversationFirstMessageId(conversationId: string, firstMessageId: string): boolean {
    const current = this.getSession(conversationId);
    if (!current) {
      this.logger.warn(`绑定 first_message_id 失败，conversation 不存在: ${conversationId}`);
      return false;
    }

    if (current.first_message_id && current.first_message_id !== firstMessageId) {
      this.logger.warn(`绑定 first_message_id 冲突: conversation=${conversationId}, current=${current.first_message_id}, new=${firstMessageId}`);
      return false;
    }

    const existing = this.getSessionByFirstMessageId(firstMessageId);
    if (existing && existing.id !== conversationId) {
      this.logger.warn(`first_message_id 已绑定到其他 conversation: messageId=${firstMessageId}, existing=${existing.id}, current=${conversationId}`);
      return false;
    }

    this.db.run(
      `UPDATE sessions SET first_message_id = ?, last_active_at = ? WHERE id = ? AND env = ?`,
      [firstMessageId, new Date().toISOString(), conversationId, this.env],
    );
    return true;
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
  saveUserMessage(sessionId: string, provider: string, text: string, ctx?: { openId?: string; chatId?: string; chatType?: string; agentSessionId?: string; agentSessionProvider?: string }): void {
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

  /** 保存主动消息记录 */
  saveProactiveMessage(messageId: string, content: string, openId?: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO proactive_messages (message_id, content, open_id, created_at) VALUES (?, ?, ?, ?)`,
      [messageId, content, openId ?? null, new Date().toISOString()]
    );
  }

  /** 查询主动消息内容（通过 message_id） */
  getProactiveMessage(messageId: string): string | null {
    const row = this.db.query(
      `SELECT content FROM proactive_messages WHERE message_id = ?`
    ).get(messageId) as { content: string } | null;
    return row?.content ?? null;
  }

  /** 更新 conversation 的 resume_id（SDK 级别的 resume ID） */
  updateResumeId(conversationId: string, resumeId: string): void {
    this.db.run(
      `UPDATE sessions SET resume_id = ? WHERE id = ?`,
      [resumeId, conversationId]
    );
  }

  /** 更新 conversation 的 provider session id 和显式 owner。 */
  updateAgentSessionId(conversationId: string, agentSessionId: string, agentSessionProvider?: string | null): void {
    this.db.run(
      `UPDATE sessions
       SET agent_session_id = ?,
           agent_session_provider = COALESCE(?, agent_session_provider)
       WHERE id = ?`,
      [agentSessionId, agentSessionProvider ?? null, conversationId]
    );
  }

  /** 更新 conversation 的 provider session owner，不改变 session id。 */
  updateAgentSessionProvider(conversationId: string, agentSessionProvider: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_provider = ? WHERE id = ?`,
      [agentSessionProvider, conversationId]
    );
  }

  /** 获取活跃 sessions（用于启动恢复）。id 即 Sage 内部 conversationId */
  getActiveSessionsForRestore(maxAgeMs: number): Array<{
    id: string;             // conversationId
    agent_session_id: string; // provider session id (cc-xxx)
    agent_session_provider: string | null;
    resume_id: string;      // SDK resume id
    provider: string;
    open_id: string;
    last_active_at: string;
  }> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return this.db.query(
      `SELECT id, agent_session_id, agent_session_provider, resume_id, provider, open_id, last_active_at
       FROM sessions
       WHERE env = ? AND agent_session_id IS NOT NULL AND last_active_at > ?
       ORDER BY last_active_at DESC`
    ).all(this.env, cutoff) as any[];
  }

  /** 按内部 conversation id 查询 session（返回 null 表示不存在） */
  getSession(conversationId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              agent_session_provider, provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE id = ? AND env = ?`
    ).get(conversationId, this.env) as ConversationSession | null ?? null;
  }

  /** 按第一条用户消息 message_id 查询 conversation。 */
  getSessionByFirstMessageId(messageId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              agent_session_provider, provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE first_message_id = ? AND env = ?`
    ).get(messageId, this.env) as ConversationSession | null ?? null;
  }

  /** 按飞书 thread_id 查询 conversation。 */
  getSessionByThreadId(threadId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              agent_session_provider, provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE thread_id = ? AND env = ?`
    ).get(threadId, this.env) as ConversationSession | null ?? null;
  }

  /** 清除 conversation 的 agent 关联（/clear 用） */
  clearSessionAgent(conversationId: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_id = NULL, agent_session_provider = NULL, resume_id = NULL WHERE id = ?`,
      [conversationId]
    );
  }

  private resolveConversationId(idOrExternalId: string): string {
    if (this.getSession(idOrExternalId)) return idOrExternalId;
    const byThread = this.getSessionByThreadId(idOrExternalId);
    if (byThread) return byThread.id;
    const firstMessageId = idOrExternalId.startsWith('msg:') ? idOrExternalId.slice(4) : idOrExternalId;
    return this.getSessionByFirstMessageId(firstMessageId)?.id ?? idOrExternalId;
  }

  /** 查询某 conversation 的全部事件；兼容传入 thread_id 或 first message_id */
  getSessionEvents(sessionId: string): any[] {
    const conversationId = this.resolveConversationId(sessionId);
    return this.db.query(
      `SELECT * FROM events WHERE session_id = ? ORDER BY position`
    ).all(conversationId);
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

  /** 获取某 conversation 最近 N 轮 user/assistant 文本对话（用于 fallback 上下文注入） */
  getRecentConversation(conversationId: string, maxTurns: number = 5): Array<{ role: string; content: string }> {
    // 子查询取最近 maxTurns*2 条（DESC），外层按 position ASC 恢复正序
    const rows = this.db.query(
      `SELECT role, content FROM (
         SELECT role, content, position FROM events
         WHERE session_id = ? AND type = 'text' AND content IS NOT NULL AND content != ''
         ORDER BY position DESC
         LIMIT ?
       ) ORDER BY position ASC`
    ).all(conversationId, maxTurns * 2) as Array<{ role: string; content: string }>;

    // 按轮次截断：从第一条 user 消息开始
    const firstUserIdx = rows.findIndex(r => r.role === 'user');
    const trimmed = firstUserIdx > 0 ? rows.slice(firstUserIdx) : rows;

    // 截断 content 避免 token 过长
    return trimmed.map(r => ({
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

  /** 按 conversation_id / first_message_id / thread_id 前缀模糊匹配 */
  findSessionsByPrefix(prefix: string): any[] {
    return this.db.query(
      `SELECT * FROM sessions
       WHERE id LIKE ? OR first_message_id LIKE ? OR thread_id LIKE ?
       ORDER BY last_active_at DESC LIMIT 10`
    ).all(`${prefix}%`, `${prefix}%`, `${prefix}%`);
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
