// 对话历史持久化 — SQLite
import { Database } from 'bun:sqlite';
import { Logger } from '../utils';
import type { AgentEvent } from '../agent/types';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';

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

      CREATE TABLE IF NOT EXISTS proactive_messages (
        message_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        open_id TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Migration: add columns and normalize legacy external ids.
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
    if (!colNames.has('first_message_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN first_message_id TEXT`);
      this.logger.info('Migration: 添加 first_message_id 列');
    }
    if (!colNames.has('thread_id')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN thread_id TEXT`);
      this.logger.info('Migration: 添加 thread_id 列');
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_first_message
      ON sessions(env, first_message_id)
      WHERE first_message_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread
      ON sessions(env, thread_id)
      WHERE thread_id IS NOT NULL;
    `);

    if (process.env.RUN_HISTORY_DATA_MIGRATIONS === '1') {
      this.backfillLegacyExternalIds();
      this.migrateLegacySessionIds();
      this.migrateOrphanLegacyEvents();
    } else {
      this.logPendingHistoryDataMigrations();
    }
  }

  private newConversationId(): string {
    return `conv_${randomUUID()}`;
  }

  private backfillLegacyExternalIds(): void {
    // Explicit data migration only. Do not call this during normal startup.
    // If a conv_* row already owns the same external id, leave the legacy row
    // unset; migrateLegacySessionIds() will merge it into the existing conv_*.
    this.db.exec(`
      UPDATE sessions AS legacy
      SET thread_id = id
      WHERE thread_id IS NULL
        AND id LIKE 'omt_%'
        AND NOT EXISTS (
          SELECT 1 FROM sessions AS existing
          WHERE existing.env = legacy.env
            AND existing.thread_id = legacy.id
            AND existing.id != legacy.id
        );

      UPDATE sessions AS legacy
      SET first_message_id = substr(id, 5)
      WHERE first_message_id IS NULL
        AND id LIKE 'msg:%'
        AND NOT EXISTS (
          SELECT 1 FROM sessions AS existing
          WHERE existing.env = legacy.env
            AND existing.first_message_id = substr(legacy.id, 5)
            AND existing.id != legacy.id
        );
    `);
  }

  private logPendingHistoryDataMigrations(): void {
    const legacySessions = this.db.query(
      `SELECT COUNT(*) AS count FROM sessions WHERE id NOT LIKE 'conv_%'`
    ).get() as { count: number } | null;
    const legacyEvents = this.db.query(
      `SELECT COUNT(*) AS count FROM events WHERE session_id NOT LIKE 'conv_%'`
    ).get() as { count: number } | null;
    const orphanEvents = this.db.query(`
      SELECT COUNT(*) AS count
      FROM events e
      LEFT JOIN sessions s ON s.id = e.session_id
      WHERE s.id IS NULL
    `).get() as { count: number } | null;

    const pending =
      (legacySessions?.count ?? 0) +
      (legacyEvents?.count ?? 0) +
      (orphanEvents?.count ?? 0);
    if (pending > 0) {
      this.logger.warn(
        `跳过历史数据迁移: legacySessions=${legacySessions?.count ?? 0}, legacyEvents=${legacyEvents?.count ?? 0}, orphanEvents=${orphanEvents?.count ?? 0}. ` +
        `如需显式迁移，设置 RUN_HISTORY_DATA_MIGRATIONS=1 后单独执行。`
      );
    }
  }

  private migrateLegacySessionIds(): void {
    const legacyRows = this.db.query(
      `SELECT id, env, provider, open_id, chat_id, chat_type,
              first_message_id, thread_id, agent_session_id, resume_id,
              started_at, last_active_at
       FROM sessions
       WHERE id NOT LIKE 'conv_%'`
    ).all() as Array<{
      id: string;
      env: string;
      provider: string;
      open_id: string | null;
      chat_id: string | null;
      chat_type: string | null;
      first_message_id: string | null;
      thread_id: string | null;
      agent_session_id: string | null;
      resume_id: string | null;
      started_at: string;
      last_active_at: string;
    }>;

    if (legacyRows.length === 0) return;

    const previousForeignKeys = this.db.query(
      `PRAGMA foreign_keys`
    ).get() as { foreign_keys: number } | null;

    const findByFirstMessage = this.db.prepare(
      `SELECT id, agent_session_id, resume_id
       FROM sessions
       WHERE env = ? AND first_message_id = ? AND id != ?
       ORDER BY last_active_at DESC LIMIT 1`
    );
    const findByThread = this.db.prepare(
      `SELECT id, agent_session_id, resume_id
       FROM sessions
       WHERE env = ? AND thread_id = ? AND id != ?
       ORDER BY last_active_at DESC LIMIT 1`
    );
    const updateSession = this.db.prepare(`
      UPDATE sessions
      SET id = ?,
          first_message_id = COALESCE(first_message_id, ?),
          thread_id = COALESCE(thread_id, ?)
      WHERE id = ?
    `);
    const maxPosition = this.db.prepare(
      `SELECT COALESCE(MAX(position), -1) AS maxPosition FROM events WHERE session_id = ?`
    );
    const moveEvents = this.db.prepare(
      `UPDATE events SET session_id = ?, position = position + ? WHERE session_id = ?`
    );
    const updateMergedSession = this.db.prepare(`
      UPDATE sessions
      SET open_id = COALESCE(open_id, ?),
          chat_id = COALESCE(chat_id, ?),
          chat_type = COALESCE(chat_type, ?),
          agent_session_id = COALESCE(agent_session_id, ?),
          resume_id = COALESCE(resume_id, ?),
          last_active_at = CASE WHEN last_active_at > ? THEN last_active_at ELSE ? END
      WHERE id = ?
    `);
    const deleteSession = this.db.prepare(`DELETE FROM sessions WHERE id = ?`);

    let mergedCount = 0;
    let renamedCount = 0;

    const migrateRows = this.db.transaction((rows: typeof legacyRows) => {
      for (const row of rows) {
        const firstMessageId = row.first_message_id ?? (row.id.startsWith('msg:') ? row.id.slice(4) : null);
        const threadId = row.thread_id ?? (row.id.startsWith('omt_') ? row.id : null);
        const existing = firstMessageId
          ? findByFirstMessage.get(row.env, firstMessageId, row.id) as { id: string; agent_session_id: string | null; resume_id: string | null } | null
          : threadId
            ? findByThread.get(row.env, threadId, row.id) as { id: string; agent_session_id: string | null; resume_id: string | null } | null
            : null;

        if (existing) {
          const pos = maxPosition.get(existing.id) as { maxPosition: number } | null;
          moveEvents.run(existing.id, (pos?.maxPosition ?? -1) + 1, row.id);
          updateMergedSession.run(
            row.open_id,
            row.chat_id,
            row.chat_type,
            row.agent_session_id,
            row.resume_id,
            row.last_active_at,
            row.last_active_at,
            existing.id,
          );
          deleteSession.run(row.id);
          mergedCount++;
          continue;
        }

        updateSession.run(this.newConversationId(), firstMessageId, threadId, row.id);
        renamedCount++;
      }
    });

    this.db.exec(`PRAGMA foreign_keys = OFF`);
    try {
      migrateRows(legacyRows);
    } finally {
      if (previousForeignKeys?.foreign_keys) {
        this.db.exec(`PRAGMA foreign_keys = ON`);
      }
    }

    this.logger.info(`Migration: legacy session id 转 conversationId: renamed=${renamedCount}, merged=${mergedCount}`);
  }

  private migrateOrphanLegacyEvents(): void {
    const orphanRows = this.db.query(`
      SELECT
        e.session_id AS oldId,
        (SELECT provider FROM events e2 WHERE e2.session_id = e.session_id ORDER BY position LIMIT 1) AS provider,
        MIN(e.ts) AS startedAt,
        MAX(e.ts) AS lastActiveAt
      FROM events e
      LEFT JOIN sessions s ON s.id = e.session_id
      WHERE s.id IS NULL AND e.session_id NOT LIKE 'conv_%'
      GROUP BY e.session_id
    `).all() as Array<{
      oldId: string;
      provider: string | null;
      startedAt: string | null;
      lastActiveAt: string | null;
    }>;

    if (orphanRows.length === 0) return;

    const previousForeignKeys = this.db.query(
      `PRAGMA foreign_keys`
    ).get() as { foreign_keys: number } | null;

    const findByFirstMessage = this.db.prepare(
      `SELECT id FROM sessions WHERE first_message_id = ? ORDER BY last_active_at DESC LIMIT 1`
    );
    const findByThread = this.db.prepare(
      `SELECT id FROM sessions WHERE thread_id = ? ORDER BY last_active_at DESC LIMIT 1`
    );
    const insertSession = this.db.prepare(`
      INSERT INTO sessions (
        id, env, provider, first_message_id, thread_id, started_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updateEvents = this.db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`);

    const migrateRows = this.db.transaction((rows: typeof orphanRows) => {
      for (const row of rows) {
        const firstMessageId = row.oldId.startsWith('msg:') ? row.oldId.slice(4) : null;
        const threadId = row.oldId.startsWith('omt_') ? row.oldId : null;

        const existing = firstMessageId
          ? findByFirstMessage.get(firstMessageId) as { id: string } | null
          : threadId
            ? findByThread.get(threadId) as { id: string } | null
            : null;

        let conversationId = existing?.id;
        if (!conversationId) {
          conversationId = this.newConversationId();
          const startedAt = row.startedAt ?? new Date().toISOString();
          const lastActiveAt = row.lastActiveAt ?? startedAt;
          insertSession.run(
            conversationId,
            this.env,
            row.provider ?? 'unknown',
            firstMessageId,
            threadId,
            startedAt,
            lastActiveAt,
          );
        }

        updateEvents.run(conversationId, row.oldId);
      }
    });

    this.db.exec(`PRAGMA foreign_keys = OFF`);
    try {
      migrateRows(orphanRows);
    } finally {
      if (previousForeignKeys?.foreign_keys) {
        this.db.exec(`PRAGMA foreign_keys = ON`);
      }
    }

    this.logger.info(`Migration: orphan legacy events 归并到 conversationId: ${orphanRows.length} 组`);
  }

  /** 创建一条 Sage 内部 conversation。message/thread 是外部字段，不作为主键。 */
  createConversation(provider: string, ctx?: {
    firstMessageId?: string;
    threadId?: string;
    openId?: string;
    chatId?: string;
    chatType?: string;
    agentSessionId?: string;
  }): string {
    const now = new Date().toISOString();
    const id = this.newConversationId();
    this.db.run(
      `INSERT INTO sessions (
         id, env, provider, open_id, chat_id, chat_type,
         first_message_id, thread_id, agent_session_id,
         started_at, last_active_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, this.env, provider,
        ctx?.openId ?? null,
        ctx?.chatId ?? null,
        ctx?.chatType ?? null,
        ctx?.firstMessageId ?? null,
        ctx?.threadId ?? null,
        ctx?.agentSessionId ?? null,
        now, now,
      ],
    );
    return id;
  }

  /** 确保 conversation 存在，不存在则按给定 id 创建。仅兼容旧调用路径。 */
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

  /** 更新 conversation 的 agent_session_id */
  updateAgentSessionId(conversationId: string, agentSessionId: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_id = ? WHERE id = ?`,
      [agentSessionId, conversationId]
    );
  }

  /** 获取活跃 sessions（用于启动恢复）。id 即 Sage 内部 conversationId */
  getActiveSessionsForRestore(maxAgeMs: number): Array<{
    id: string;             // conversationId
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

  /** 按内部 conversation id 查询 session（返回 null 表示不存在） */
  getSession(conversationId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE id = ? AND env = ?`
    ).get(conversationId, this.env) as ConversationSession | null ?? null;
  }

  /** 按第一条用户消息 message_id 查询 conversation。 */
  getSessionByFirstMessageId(messageId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE first_message_id = ? AND env = ?`
    ).get(messageId, this.env) as ConversationSession | null ?? null;
  }

  /** 按飞书 thread_id 查询 conversation。 */
  getSessionByThreadId(threadId: string): ConversationSession | null {
    return this.db.query(
      `SELECT id, first_message_id, thread_id, agent_session_id, resume_id,
              provider, open_id, chat_id, chat_type, last_active_at
       FROM sessions WHERE thread_id = ? AND env = ?`
    ).get(threadId, this.env) as ConversationSession | null ?? null;
  }

  /** 清除 conversation 的 agent 关联（/clear 用） */
  clearSessionAgent(conversationId: string): void {
    this.db.run(
      `UPDATE sessions SET agent_session_id = NULL, resume_id = NULL WHERE id = ?`,
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
