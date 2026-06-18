import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { Logger } from '../utils';
import { runDatabaseMigrations, runHistoryDataMigrations } from './db-migrations';

function columnNames(db: Database, tableName: string): string[] {
  return (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function appliedMigrationCount(db: Database, schemaId: string): number {
  const row = db.query(`
    SELECT COUNT(*) AS count
    FROM _sage_migrations
    WHERE schema_id = ?
  `).get(schemaId) as { count: number };
  return row.count;
}

describe('database migrations', () => {
  it('creates app schemas through the centralized runner and records applied migrations', () => {
    const db = new Database(':memory:');

    runDatabaseMigrations('investment', db);
    runDatabaseMigrations('investment', db);

    expect(columnNames(db, 'instruments')).toContain('metadata_json');
    expect(columnNames(db, 'report_runs')).toContain('workspace_output_path');
    expect(appliedMigrationCount(db, 'investment')).toBe(1);
  });

  it('upgrades legacy scheduler task tables in place', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE dynamic_tasks (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        pattern TEXT,
        trigger_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );
    `);

    runDatabaseMigrations('scheduler', db);

    expect(columnNames(db, 'dynamic_tasks')).toEqual(expect.arrayContaining([
      'kind',
      'title',
      'payload',
      'context_json',
    ]));
    expect(appliedMigrationCount(db, 'scheduler')).toBe(2);
  });

  it('adds and backfills history agent session provider owners', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        env TEXT NOT NULL DEFAULT 'production',
        provider TEXT NOT NULL,
        open_id TEXT,
        chat_id TEXT,
        chat_type TEXT,
        started_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        summary TEXT,
        keywords TEXT,
        agent_session_id TEXT,
        resume_id TEXT,
        first_message_id TEXT,
        thread_id TEXT
      );

      INSERT INTO sessions (
        id, env, provider, started_at, last_active_at, agent_session_id
      ) VALUES
        ('conv_codex', 'test', 'codex+claude-code', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'cdx-legacy'),
        ('conv_unknown', 'test', 'codex+claude-code', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'providerless-legacy');
    `);

    runDatabaseMigrations('history', db);

    expect(columnNames(db, 'sessions')).toContain('agent_session_provider');
    const rows = db.query(`
      SELECT id, agent_session_provider
      FROM sessions
      ORDER BY id
    `).all() as Array<{ id: string; agent_session_provider: string | null }>;

    expect(rows).toEqual([
      { id: 'conv_codex', agent_session_provider: 'codex' },
      { id: 'conv_unknown', agent_session_provider: null },
    ]);
    expect(appliedMigrationCount(db, 'history')).toBe(3);
  });

  it('keeps history data migrations explicit while centralizing the implementation', () => {
    const db = new Database(':memory:');
    runDatabaseMigrations('history', db);
    db.exec(`
      INSERT INTO sessions (
        id, env, provider, started_at, last_active_at
      ) VALUES (
        'msg:legacy-first-message', 'test', 'fake-agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

      INSERT INTO events (
        session_id, provider, role, type, position, content, ts
      ) VALUES (
        'msg:legacy-first-message', 'fake-agent', 'user', 'text', 0, 'hello', '2026-01-01T00:00:00.000Z'
      );
    `);

    runHistoryDataMigrations(db, { env: 'test', enabled: true });

    const session = db.query(`
      SELECT id, first_message_id
      FROM sessions
      WHERE first_message_id = 'legacy-first-message'
    `).get() as { id: string; first_message_id: string } | null;
    expect(session).not.toBeNull();
    const conversationId = session!.id;
    expect(conversationId.startsWith('conv_')).toBe(true);
    expect(session!.first_message_id).toBe('legacy-first-message');

    const event = db.query(`SELECT session_id FROM events`).get() as { session_id: string };
    expect(event.session_id).toBe(conversationId);
  });

  it('logs skipped explicit history data migrations at info level', () => {
    const db = new Database(':memory:');
    runDatabaseMigrations('history', db);
    db.exec(`
      INSERT INTO sessions (
        id, env, provider, started_at, last_active_at
      ) VALUES (
        'msg:legacy-first-message', 'test', 'fake-agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);

    const logger = new Logger('DbMigrationsTest');
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];
    logger.info = (message: string) => {
      infoMessages.push(message);
    };
    logger.warn = (message: string) => {
      warnMessages.push(message);
    };

    runHistoryDataMigrations(db, { env: 'test', enabled: false, logger });

    expect(warnMessages).toEqual([]);
    expect(infoMessages).toHaveLength(1);
    expect(infoMessages[0]).toContain('跳过历史数据迁移');
  });
});
