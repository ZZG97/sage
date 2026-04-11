import { readdirSync } from 'fs';
import { resolve } from 'path';
import { Database } from 'bun:sqlite';

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export interface DebugDatabaseInfo {
  name: string;
  tableCount: number;
}

export interface DebugTableInfo {
  name: string;
  columns: TableColumn[];
  count: number;
  defaultOrderBy: string | null;
  defaultOrderDirection: 'desc';
}

export interface DebugTableRowsResult {
  table: string;
  columns: string[];
  count: number;
  rows: Record<string, unknown>[];
  orderBy: string | null;
  orderDirection: 'desc';
}

const TABLE_IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
const DATABASE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TIME_ORDER_COLUMNS = [
  'updated_at',
  'created_at',
  'last_active_at',
  'started_at',
  'visit_date',
  'measured_at',
  'ts',
];

function assertTableIdentifier(value: string, kind: string): string {
  if (!TABLE_IDENTIFIER_RE.test(value)) {
    throw new Error(`非法${kind}: ${value}`);
  }
  return value;
}

function assertDatabaseName(value: string): string {
  if (!DATABASE_NAME_RE.test(value)) {
    throw new Error(`非法数据库名: ${value}`);
  }
  return value;
}

function resolveDefaultOrder(columns: TableColumn[]): string | null {
  for (const name of TIME_ORDER_COLUMNS) {
    if (columns.some((column) => column.name === name)) {
      return name;
    }
  }

  const primaryKey = columns.find((column) => column.pk > 0);
  if (primaryKey) {
    return primaryKey.name;
  }

  const idColumn = columns.find((column) => column.name === 'id');
  return idColumn?.name ?? null;
}

export class DebugService {
  private readonly dataDir = resolve(import.meta.dir, '../../../data');
  private readonly connections = new Map<string, Database>();

  listDatabases(): DebugDatabaseInfo[] {
    return readdirSync(this.dataDir)
      .filter((file) => file.endsWith('.db'))
      .map((file) => file.slice(0, -3))
      .sort()
      .map((name) => {
        const db = this.getValidatedDatabase(name);
        const tableCount = (db.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `).get() as { count: number }).count;
        return { name, tableCount };
      });
  }

  listTables(databaseName: string): DebugTableInfo[] {
    const db = this.getValidatedDatabase(databaseName);
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;

    return tables.map(({ name }) => {
      const columns = this.getTableColumns(db, name);
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count;
      return {
        name,
        columns,
        count,
        defaultOrderBy: resolveDefaultOrder(columns),
        defaultOrderDirection: 'desc' as const,
      };
    });
  }

  getTableRows(databaseName: string, tableName: string, limit?: number): DebugTableRowsResult {
    const db = this.getValidatedDatabase(databaseName);
    const safeTableName = assertTableIdentifier(tableName, '表名');
    const tableExists = this.listTables(databaseName).some((table) => table.name === safeTableName);

    if (!tableExists) {
      throw new Error(`表不存在: ${safeTableName}`);
    }

    const columns = this.getTableColumns(db, safeTableName);
    const columnNames = columns.map((column) => column.name);
    const count = (db.prepare(`SELECT COUNT(*) AS count FROM "${safeTableName}"`).get() as { count: number }).count;
    const orderBy = resolveDefaultOrder(columns);
    const normalizedLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const orderClause = orderBy ? ` ORDER BY "${orderBy}" DESC` : '';
    const rows = db.prepare(`SELECT * FROM "${safeTableName}"${orderClause} LIMIT ?`).all(normalizedLimit) as Record<string, unknown>[];

    return {
      table: safeTableName,
      columns: columnNames,
      count,
      rows,
      orderBy,
      orderDirection: 'desc',
    };
  }

  private getValidatedDatabase(name: string): Database {
    const safeName = assertDatabaseName(name);
    const exists = readdirSync(this.dataDir).some((file) => file === `${safeName}.db`);
    if (!exists) {
      throw new Error(`数据库不存在: ${safeName}`);
    }
    if (this.connections.has(safeName)) {
      return this.connections.get(safeName)!;
    }

    const dbPath = resolve(this.dataDir, `${safeName}.db`);
    const db = new Database(dbPath, { readonly: true });
    this.connections.set(safeName, db);
    return db;
  }

  private getTableColumns(db: Database, tableName: string): TableColumn[] {
    const safeTableName = assertTableIdentifier(tableName, '表名');
    return db.prepare(`PRAGMA table_info("${safeTableName}")`).all() as TableColumn[];
  }
}
