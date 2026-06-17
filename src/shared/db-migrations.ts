import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { Logger } from '../utils';

export type DatabaseSchemaId =
  | 'history'
  | 'scheduler'
  | 'investment'
  | 'health'
  | 'operations'
  | 'rss-ai';

interface MigrationContext {
  schemaId: DatabaseSchemaId;
  logger: Logger;
}

interface DatabaseMigration {
  id: string;
  description: string;
  up: (db: Database, ctx: MigrationContext) => void;
}

interface RunMigrationOptions {
  logger?: Logger;
}

interface HistoryDataMigrationOptions {
  env: string;
  enabled: boolean;
  logger?: Logger;
}

const defaultLogger = new Logger('DbMigrations');

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableColumns(db: Database, tableName: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumnIfMissing(db: Database, tableName: string, columnName: string, columnDefinition: string): void {
  if (tableColumns(db, tableName).has(columnName)) return;
  db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${columnDefinition}`);
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _sage_migrations (
      schema_id TEXT NOT NULL,
      id TEXT NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (schema_id, id)
    );
  `);
}

const migrations: Record<DatabaseSchemaId, DatabaseMigration[]> = {
  history: [
    {
      id: '001_initial_schema',
      description: 'create conversation history tables and indexes',
      up(db) {
        db.exec(`
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
            keywords TEXT,
            agent_session_id TEXT,
            agent_session_provider TEXT,
            resume_id TEXT,
            first_message_id TEXT,
            thread_id TEXT
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
      },
    },
    {
      id: '002_session_external_refs',
      description: 'add provider and external message reference columns',
      up(db) {
        addColumnIfMissing(db, 'sessions', 'agent_session_id', 'agent_session_id TEXT');
        addColumnIfMissing(db, 'sessions', 'agent_session_provider', 'agent_session_provider TEXT');
        addColumnIfMissing(db, 'sessions', 'resume_id', 'resume_id TEXT');
        addColumnIfMissing(db, 'sessions', 'first_message_id', 'first_message_id TEXT');
        addColumnIfMissing(db, 'sessions', 'thread_id', 'thread_id TEXT');

        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_first_message
          ON sessions(env, first_message_id)
          WHERE first_message_id IS NOT NULL;

          CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread
          ON sessions(env, thread_id)
          WHERE thread_id IS NOT NULL;
        `);
      },
    },
    {
      id: '003_agent_session_provider',
      description: 'persist provider owner for agent sessions',
      up(db) {
        addColumnIfMissing(db, 'sessions', 'agent_session_provider', 'agent_session_provider TEXT');
        db.exec(`
          UPDATE sessions
          SET agent_session_provider = CASE
            WHEN agent_session_id LIKE 'cdx-%' THEN 'codex'
            WHEN agent_session_id LIKE 'ccm-%' THEN 'cc-minimax'
            WHEN agent_session_id LIKE 'cc-%' THEN 'claude-code'
            WHEN agent_session_id LIKE 'oc-%' THEN 'opencode'
            ELSE agent_session_provider
          END
          WHERE agent_session_id IS NOT NULL
            AND agent_session_provider IS NULL;

          CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_provider
          ON sessions(env, agent_session_provider)
          WHERE agent_session_provider IS NOT NULL;
        `);
      },
    },
  ],
  scheduler: [
    {
      id: '001_dynamic_tasks',
      description: 'create dynamic scheduler task table',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS dynamic_tasks (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL DEFAULT 'message',
            message TEXT NOT NULL,
            title TEXT,
            payload TEXT,
            context_json TEXT,
            pattern TEXT,
            trigger_at INTEGER,
            status TEXT NOT NULL DEFAULT 'active',
            created_at INTEGER NOT NULL
          );
        `);
      },
    },
    {
      id: '002_dynamic_task_payload_fields',
      description: 'add dynamic task payload fields for agent and workflow tasks',
      up(db) {
        addColumnIfMissing(db, 'dynamic_tasks', 'kind', `kind TEXT NOT NULL DEFAULT 'message'`);
        addColumnIfMissing(db, 'dynamic_tasks', 'title', 'title TEXT');
        addColumnIfMissing(db, 'dynamic_tasks', 'payload', 'payload TEXT');
        addColumnIfMissing(db, 'dynamic_tasks', 'context_json', 'context_json TEXT');
      },
    },
  ],
  investment: [
    {
      id: '001_initial_schema',
      description: 'create investment research tables and indexes',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS instruments (
            id TEXT PRIMARY KEY,
            symbol TEXT NOT NULL,
            name TEXT NOT NULL,
            market TEXT NOT NULL,
            asset_type TEXT NOT NULL,
            industry TEXT,
            themes_json TEXT NOT NULL DEFAULT '[]',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (market, symbol)
          );

          CREATE TABLE IF NOT EXISTS portfolios (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            base_currency TEXT NOT NULL DEFAULT 'CNY',
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS holding_snapshots (
            id TEXT PRIMARY KEY,
            portfolio_id TEXT NOT NULL,
            instrument_id TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            snapshot_run_id TEXT NOT NULL,
            quantity REAL NOT NULL,
            cost_basis REAL,
            cost_currency TEXT,
            last_price REAL,
            price_currency TEXT,
            market_value REAL,
            market_value_base REAL,
            unrealized_pnl REAL,
            unrealized_pnl_pct REAL,
            weight REAL,
            source TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (portfolio_id, instrument_id, snapshot_run_id),
            FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
            FOREIGN KEY (instrument_id) REFERENCES instruments(id)
          );

          CREATE TABLE IF NOT EXISTS position_notes (
            id TEXT PRIMARY KEY,
            portfolio_id TEXT NOT NULL,
            instrument_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'holding',
            conviction TEXT,
            thesis TEXT,
            buy_reason TEXT,
            risk_notes TEXT,
            invalidation_condition TEXT,
            review_cadence TEXT,
            next_review_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (portfolio_id, instrument_id),
            FOREIGN KEY (portfolio_id) REFERENCES portfolios(id),
            FOREIGN KEY (instrument_id) REFERENCES instruments(id)
          );

          CREATE TABLE IF NOT EXISTS source_documents (
            id TEXT PRIMARY KEY,
            url TEXT,
            title TEXT,
            publisher TEXT,
            author TEXT,
            published_at TEXT,
            fetched_at TEXT NOT NULL,
            source_type TEXT NOT NULL,
            content_type TEXT NOT NULL,
            raw_path TEXT,
            text_path TEXT,
            hash TEXT,
            status TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            UNIQUE (url, hash)
          );

          CREATE TABLE IF NOT EXISTS evidence_items (
            id TEXT PRIMARY KEY,
            source_document_id TEXT NOT NULL,
            evidence_type TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            summary TEXT NOT NULL,
            quote TEXT,
            period TEXT,
            confidence TEXT NOT NULL,
            extraction_method TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            FOREIGN KEY (source_document_id) REFERENCES source_documents(id)
          );

          CREATE TABLE IF NOT EXISTS metric_observations (
            id TEXT PRIMARY KEY,
            metric_key TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            period TEXT,
            as_of_date TEXT,
            value REAL NOT NULL,
            unit TEXT,
            currency TEXT,
            source_document_id TEXT,
            evidence_item_id TEXT,
            source_quality TEXT NOT NULL,
            extraction_method TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (source_document_id) REFERENCES source_documents(id),
            FOREIGN KEY (evidence_item_id) REFERENCES evidence_items(id)
          );

          CREATE TABLE IF NOT EXISTS signals (
            id TEXT PRIMARY KEY,
            portfolio_id TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            signal_type TEXT NOT NULL,
            direction TEXT NOT NULL,
            strength TEXT NOT NULL,
            summary TEXT NOT NULL,
            explanation TEXT,
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            generated_at TEXT NOT NULL,
            expires_at TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
          );

          CREATE TABLE IF NOT EXISTS report_runs (
            id TEXT PRIMARY KEY,
            report_type TEXT NOT NULL,
            portfolio_id TEXT NOT NULL,
            period_start TEXT,
            period_end TEXT,
            status TEXT NOT NULL,
            operation_run_id TEXT,
            output_path TEXT,
            workspace_output_path TEXT,
            summary TEXT,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            finished_at TEXT,
            FOREIGN KEY (portfolio_id) REFERENCES portfolios(id)
          );

          CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments(symbol);
          CREATE INDEX IF NOT EXISTS idx_holdings_portfolio_date ON holding_snapshots(portfolio_id, snapshot_date);
          CREATE INDEX IF NOT EXISTS idx_holdings_portfolio_run ON holding_snapshots(portfolio_id, snapshot_run_id);
          CREATE INDEX IF NOT EXISTS idx_holdings_instrument_date ON holding_snapshots(instrument_id, snapshot_date);
          CREATE INDEX IF NOT EXISTS idx_position_notes_portfolio ON position_notes(portfolio_id);
          CREATE INDEX IF NOT EXISTS idx_source_documents_fetched_at ON source_documents(fetched_at);
          CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence_items(entity_type, entity_id);
          CREATE INDEX IF NOT EXISTS idx_metrics_entity_key ON metric_observations(entity_type, entity_id, metric_key);
          CREATE INDEX IF NOT EXISTS idx_signals_portfolio_status ON signals(portfolio_id, status);
          CREATE INDEX IF NOT EXISTS idx_report_runs_portfolio_type ON report_runs(portfolio_id, report_type);
        `);
      },
    },
  ],
  health: [
    {
      id: '001_initial_schema',
      description: 'create health record tables and indexes',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS medical_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            visit_date TEXT NOT NULL,
            hospital TEXT,
            department TEXT,
            doctor TEXT,
            chief_complaint TEXT,
            diagnosis TEXT,
            medications TEXT,
            examinations TEXT,
            treatment TEXT,
            doctor_advice TEXT,
            follow_up_date TEXT,
            cost REAL,
            tags TEXT,
            attachments TEXT,
            raw_analysis TEXT,
            summary TEXT,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            updated_at TEXT DEFAULT (datetime('now', 'localtime'))
          );

          CREATE TABLE IF NOT EXISTS health_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            value TEXT NOT NULL,
            numeric_value REAL,
            unit TEXT,
            reference_range TEXT,
            is_abnormal INTEGER DEFAULT 0,
            measured_at TEXT,
            FOREIGN KEY (record_id) REFERENCES medical_records(id)
          );

          CREATE TABLE IF NOT EXISTS medication_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            record_id INTEGER,
            medication_name TEXT NOT NULL,
            generic_name TEXT,
            dosage TEXT,
            frequency TEXT,
            route TEXT,
            start_date TEXT,
            end_date TEXT,
            is_active INTEGER DEFAULT 1,
            notes TEXT,
            FOREIGN KEY (record_id) REFERENCES medical_records(id)
          );

          CREATE INDEX IF NOT EXISTS idx_records_visit_date ON medical_records(visit_date);
          CREATE INDEX IF NOT EXISTS idx_records_department ON medical_records(department);
          CREATE INDEX IF NOT EXISTS idx_metrics_record_id ON health_metrics(record_id);
          CREATE INDEX IF NOT EXISTS idx_metrics_name ON health_metrics(metric_name);
          CREATE INDEX IF NOT EXISTS idx_medication_name ON medication_history(medication_name);
          CREATE INDEX IF NOT EXISTS idx_medication_active ON medication_history(is_active);
        `);
      },
    },
  ],
  operations: [
    {
      id: '001_initial_schema',
      description: 'create operation ledger tables and indexes',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS operation_runs (
            id TEXT PRIMARY KEY,
            operation_type TEXT NOT NULL,
            operation_name TEXT NOT NULL,
            trigger_type TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            duration_ms INTEGER,
            summary TEXT,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            error TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            request_id TEXT,
            trace_id TEXT,
            alerted_at INTEGER
          );

          CREATE INDEX IF NOT EXISTS idx_operation_runs_started ON operation_runs(started_at);
          CREATE INDEX IF NOT EXISTS idx_operation_runs_status ON operation_runs(status);
          CREATE INDEX IF NOT EXISTS idx_operation_runs_type ON operation_runs(operation_type, operation_name, started_at);

          CREATE TABLE IF NOT EXISTS operation_health_alerts (
            alert_key TEXT PRIMARY KEY,
            last_alerted_at INTEGER NOT NULL
          );
        `);
      },
    },
  ],
  'rss-ai': [
    {
      id: '001_initial_schema',
      description: 'create RSS AI sidecar tables and indexes',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS processed_entries (
            entry_id INTEGER PRIMARY KEY,
            feed_id INTEGER NOT NULL,
            guid TEXT NOT NULL,
            link TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            priority TEXT NOT NULL,
            topics_json TEXT NOT NULL,
            labels_json TEXT NOT NULL,
            confidence REAL NOT NULL,
            reason TEXT NOT NULL,
            fact_or_opinion TEXT NOT NULL,
            model TEXT NOT NULL,
            dry_run INTEGER NOT NULL DEFAULT 0,
            cluster_id TEXT,
            author_key TEXT,
            summary TEXT,
            processed_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_rss_processed_feed ON processed_entries(feed_id);
          CREATE INDEX IF NOT EXISTS idx_rss_processed_priority ON processed_entries(priority);
          CREATE INDEX IF NOT EXISTS idx_rss_processed_at ON processed_entries(processed_at);

          CREATE TABLE IF NOT EXISTS feed_refresh_state (
            feed_id INTEGER NOT NULL,
            domain TEXT NOT NULL,
            last_attempt_at INTEGER,
            last_success_at INTEGER,
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            backoff_until INTEGER,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (feed_id, domain)
          );

          CREATE TABLE IF NOT EXISTS refresh_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            feed_id INTEGER NOT NULL,
            feed_name TEXT NOT NULL,
            domain TEXT NOT NULL,
            ok INTEGER NOT NULL,
            new_articles INTEGER NOT NULL,
            updated_feeds INTEGER NOT NULL,
            reason TEXT NOT NULL,
            stdout TEXT NOT NULL,
            stderr TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now', 'localtime'))
          );

          CREATE INDEX IF NOT EXISTS idx_rss_refresh_runs_feed ON refresh_runs(feed_id);
          CREATE INDEX IF NOT EXISTS idx_rss_refresh_runs_created ON refresh_runs(created_at);
        `);
      },
    },
  ],
};

export function runDatabaseMigrations(schemaId: DatabaseSchemaId, db: Database, options: RunMigrationOptions = {}): void {
  const logger = options.logger ?? defaultLogger;
  const schemaMigrations = migrations[schemaId];
  if (!schemaMigrations) {
    throw new Error(`No database migrations registered for schema: ${schemaId}`);
  }

  ensureMigrationTable(db);
  const appliedRows = db.query(`SELECT id FROM _sage_migrations WHERE schema_id = ?`).all(schemaId) as Array<{ id: string }>;
  const applied = new Set(appliedRows.map((row) => row.id));
  const insertApplied = db.prepare(`
    INSERT INTO _sage_migrations (schema_id, id, description, applied_at)
    VALUES (?, ?, ?, datetime('now'))
  `);

  for (const migration of schemaMigrations) {
    if (applied.has(migration.id)) continue;

    const applyMigration = db.transaction(() => {
      migration.up(db, { schemaId, logger });
      insertApplied.run(schemaId, migration.id, migration.description);
    });
    applyMigration();
    logger.info(`DB migration applied: ${schemaId}/${migration.id} - ${migration.description}`);
  }
}

export function runHistoryDataMigrations(db: Database, options: HistoryDataMigrationOptions): void {
  const logger = options.logger ?? defaultLogger;
  if (!options.enabled) {
    logPendingHistoryDataMigrations(db, logger);
    return;
  }

  backfillLegacyExternalIds(db);
  migrateLegacySessionIds(db, logger);
  migrateOrphanLegacyEvents(db, options.env, logger);
}

function newConversationId(): string {
  return `conv_${randomUUID()}`;
}

function backfillLegacyExternalIds(db: Database): void {
  // Explicit data migration only. Do not call this during normal startup.
  // If a conv_* row already owns the same external id, leave the legacy row
  // unset; migrateLegacySessionIds() will merge it into the existing conv_*.
  db.exec(`
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

function logPendingHistoryDataMigrations(db: Database, logger: Logger): void {
  const legacySessions = db.query(
    `SELECT COUNT(*) AS count FROM sessions WHERE id NOT LIKE 'conv_%'`
  ).get() as { count: number } | null;
  const legacyEvents = db.query(
    `SELECT COUNT(*) AS count FROM events WHERE session_id NOT LIKE 'conv_%'`
  ).get() as { count: number } | null;
  const orphanEvents = db.query(`
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
    logger.warn(
      `跳过历史数据迁移: legacySessions=${legacySessions?.count ?? 0}, legacyEvents=${legacyEvents?.count ?? 0}, orphanEvents=${orphanEvents?.count ?? 0}. ` +
      `如需显式迁移，设置 RUN_HISTORY_DATA_MIGRATIONS=1 后单独执行。`
    );
  }
}

function migrateLegacySessionIds(db: Database, logger: Logger): void {
  const legacyRows = db.query(
    `SELECT id, env, provider, open_id, chat_id, chat_type,
            first_message_id, thread_id, agent_session_id, agent_session_provider, resume_id,
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
    agent_session_provider: string | null;
    resume_id: string | null;
    started_at: string;
    last_active_at: string;
  }>;

  if (legacyRows.length === 0) return;

  const previousForeignKeys = db.query(
    `PRAGMA foreign_keys`
  ).get() as { foreign_keys: number } | null;

  const findByFirstMessage = db.prepare(
    `SELECT id, agent_session_id, agent_session_provider, resume_id
     FROM sessions
     WHERE env = ? AND first_message_id = ? AND id != ?
     ORDER BY last_active_at DESC LIMIT 1`
  );
  const findByThread = db.prepare(
    `SELECT id, agent_session_id, agent_session_provider, resume_id
     FROM sessions
     WHERE env = ? AND thread_id = ? AND id != ?
     ORDER BY last_active_at DESC LIMIT 1`
  );
  const updateSession = db.prepare(`
    UPDATE sessions
    SET id = ?,
        first_message_id = COALESCE(first_message_id, ?),
        thread_id = COALESCE(thread_id, ?)
    WHERE id = ?
  `);
  const maxPosition = db.prepare(
    `SELECT COALESCE(MAX(position), -1) AS maxPosition FROM events WHERE session_id = ?`
  );
  const moveEvents = db.prepare(
    `UPDATE events SET session_id = ?, position = position + ? WHERE session_id = ?`
  );
  const updateMergedSession = db.prepare(`
    UPDATE sessions
    SET open_id = COALESCE(open_id, ?),
        chat_id = COALESCE(chat_id, ?),
        chat_type = COALESCE(chat_type, ?),
        agent_session_id = COALESCE(agent_session_id, ?),
        agent_session_provider = COALESCE(agent_session_provider, ?),
        resume_id = COALESCE(resume_id, ?),
        last_active_at = CASE WHEN last_active_at > ? THEN last_active_at ELSE ? END
    WHERE id = ?
  `);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = ?`);

  let mergedCount = 0;
  let renamedCount = 0;

  const migrateRows = db.transaction((rows: typeof legacyRows) => {
    for (const row of rows) {
      const firstMessageId = row.first_message_id ?? (row.id.startsWith('msg:') ? row.id.slice(4) : null);
      const threadId = row.thread_id ?? (row.id.startsWith('omt_') ? row.id : null);
      const existing = firstMessageId
        ? findByFirstMessage.get(row.env, firstMessageId, row.id) as { id: string; agent_session_id: string | null; agent_session_provider: string | null; resume_id: string | null } | null
        : threadId
          ? findByThread.get(row.env, threadId, row.id) as { id: string; agent_session_id: string | null; agent_session_provider: string | null; resume_id: string | null } | null
          : null;

      if (existing) {
        const pos = maxPosition.get(existing.id) as { maxPosition: number } | null;
        moveEvents.run(existing.id, (pos?.maxPosition ?? -1) + 1, row.id);
        updateMergedSession.run(
          row.open_id,
          row.chat_id,
          row.chat_type,
          row.agent_session_id,
          row.agent_session_provider,
          row.resume_id,
          row.last_active_at,
          row.last_active_at,
          existing.id,
        );
        deleteSession.run(row.id);
        mergedCount++;
        continue;
      }

      updateSession.run(newConversationId(), firstMessageId, threadId, row.id);
      renamedCount++;
    }
  });

  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    migrateRows(legacyRows);
  } finally {
    if (previousForeignKeys?.foreign_keys) {
      db.exec(`PRAGMA foreign_keys = ON`);
    }
  }

  logger.info(`Migration: legacy session id 转 conversationId: renamed=${renamedCount}, merged=${mergedCount}`);
}

function migrateOrphanLegacyEvents(db: Database, env: string, logger: Logger): void {
  const orphanRows = db.query(`
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

  const previousForeignKeys = db.query(
    `PRAGMA foreign_keys`
  ).get() as { foreign_keys: number } | null;

  const findByFirstMessage = db.prepare(
    `SELECT id FROM sessions WHERE first_message_id = ? ORDER BY last_active_at DESC LIMIT 1`
  );
  const findByThread = db.prepare(
    `SELECT id FROM sessions WHERE thread_id = ? ORDER BY last_active_at DESC LIMIT 1`
  );
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, env, provider, first_message_id, thread_id, started_at, last_active_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const updateEvents = db.prepare(`UPDATE events SET session_id = ? WHERE session_id = ?`);

  const migrateRows = db.transaction((rows: typeof orphanRows) => {
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
        conversationId = newConversationId();
        const startedAt = row.startedAt ?? new Date().toISOString();
        const lastActiveAt = row.lastActiveAt ?? startedAt;
        insertSession.run(
          conversationId,
          env,
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

  db.exec(`PRAGMA foreign_keys = OFF`);
  try {
    migrateRows(orphanRows);
  } finally {
    if (previousForeignKeys?.foreign_keys) {
      db.exec(`PRAGMA foreign_keys = ON`);
    }
  }

  logger.info(`Migration: orphan legacy events 归并到 conversationId: ${orphanRows.length} 组`);
}
