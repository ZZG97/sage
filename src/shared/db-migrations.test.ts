import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
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
});
