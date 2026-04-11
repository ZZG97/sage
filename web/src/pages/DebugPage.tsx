import { useEffect, useState } from 'react';
import { Card, CardTitle, StatValue } from '@/components/Card';
import {
  debugApi,
  type DebugDatabaseInfo,
  type DebugRowsResult,
  type DebugTableInfo,
} from '@/lib/api';
import { clsx } from 'clsx';

function summarizeRow(row: Record<string, unknown>, columns: string[]): string {
  for (const column of columns) {
    const value = row[column];
    if (typeof value === 'string' && value.trim()) {
      return value.length > 120 ? `${value.slice(0, 120)}...` : value;
    }
  }
  return JSON.stringify(row).slice(0, 120);
}

function getRowKey(row: Record<string, unknown>, index: number): string {
  const id = row.id;
  if (typeof id === 'string' || typeof id === 'number') {
    return String(id);
  }
  return `row-${index}`;
}

export function DebugPage() {
  const [databases, setDatabases] = useState<DebugDatabaseInfo[]>([]);
  const [tables, setTables] = useState<DebugTableInfo[]>([]);
  const [rowsData, setRowsData] = useState<DebugRowsResult | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState('');
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedRowIndex, setSelectedRowIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tableLoading, setTableLoading] = useState(false);
  const [rowLoading, setRowLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    const loadDatabases = async () => {
      setLoading(true);
      setError(null);

      try {
        const databaseList = await debugApi.getDatabases();
        setDatabases(databaseList);
        if (databaseList.length > 0) {
          setSelectedDatabase((current) => current || databaseList[0].name);
        }
      } catch (err: any) {
        setError(err.message || '加载数据库失败');
      } finally {
        setLoading(false);
      }
    };

    void loadDatabases();
  }, []);

  useEffect(() => {
    if (!selectedDatabase) return;

    const loadTables = async () => {
      setTableLoading(true);
      setError(null);
      setRowsData(null);
      setSelectedTable('');
      setSelectedRowIndex(0);

      try {
        const tableList = await debugApi.getTables(selectedDatabase);
        setTables(tableList);
        setSelectedTable((current) => {
          if (current && tableList.some((table) => table.name === current)) {
            return current;
          }
          return tableList[0]?.name ?? '';
        });
      } catch (err: any) {
        setError(err.message || '加载表失败');
        setTables([]);
        setSelectedTable('');
      } finally {
        setTableLoading(false);
      }
    };

    void loadTables();
  }, [selectedDatabase, reloadVersion]);

  useEffect(() => {
    if (!selectedDatabase || !selectedTable) return;

    const loadRows = async () => {
      setRowLoading(true);
      setError(null);

      try {
        const result = await debugApi.getRows(selectedDatabase, selectedTable, 100);
        setRowsData(result);
        setSelectedRowIndex(0);
      } catch (err: any) {
        setError(err.message || '加载数据失败');
        setRowsData(null);
      } finally {
        setRowLoading(false);
      }
    };

    void loadRows();
  }, [selectedDatabase, selectedTable, reloadVersion]);

  const selectedTableInfo = tables.find((table) => table.name === selectedTable) ?? null;
  const selectedRow = rowsData?.rows[selectedRowIndex] ?? null;

  if (loading) {
    return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Debug Data Browser</h2>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            只读查看 SQLite 数据，默认按主键或时间字段倒序展示最近 100 条。
          </p>
        </div>
        <button
          onClick={() => setReloadVersion((value) => value + 1)}
          className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 text-[var(--color-danger)] text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <StatValue value={databases.length} label="Databases" />
        </Card>
        <Card>
          <StatValue value={tables.length} label="Tables" />
        </Card>
        <Card>
          <StatValue value={rowsData?.count ?? 0} label="Rows In Table" />
        </Card>
        <Card>
          <StatValue value={rowsData?.rows.length ?? 0} label="Loaded Rows" />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[280px_320px_minmax(0,1fr)] gap-6">
        <Card>
          <CardTitle>Database</CardTitle>
          <div className="space-y-2">
            {databases.map((database) => (
              <button
                key={database.name}
                onClick={() => setSelectedDatabase(database.name)}
                className={clsx(
                  'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                  selectedDatabase === database.name
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]',
                )}
              >
                <div className="font-medium">{database.name}</div>
                <div className="text-xs text-[var(--color-text-secondary)] mt-1">
                  {database.tableCount} tables
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <CardTitle>Tables</CardTitle>
          {tableLoading ? (
            <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
          ) : tables.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)]">No tables</div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {tables.map((table) => (
                <button
                  key={table.name}
                  onClick={() => setSelectedTable(table.name)}
                  className={clsx(
                    'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                    selectedTable === table.name
                      ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                      : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]',
                  )}
                >
                  <div className="font-medium">{table.name}</div>
                  <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                    {table.count} rows · {table.columns.length} cols
                  </div>
                  {table.defaultOrderBy && (
                    <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
                      default sort: {table.defaultOrderBy} desc
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="min-h-[60vh]">
          <CardTitle>Rows</CardTitle>
          {selectedTableInfo && (
            <div className="mb-4 flex flex-wrap gap-2">
              {selectedTableInfo.columns.map((column) => (
                <span
                  key={column.name}
                  className="rounded-full border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
                >
                  {column.name}
                </span>
              ))}
            </div>
          )}

          {rowLoading ? (
            <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
          ) : !rowsData ? (
            <div className="text-sm text-[var(--color-text-secondary)]">Select a table</div>
          ) : rowsData.rows.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)]">Table is empty</div>
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-[360px_minmax(0,1fr)] gap-4">
              <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
                <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
                  {rowsData.table}
                  {rowsData.orderBy && ` · ${rowsData.orderBy} desc`}
                </div>
                <div className="max-h-[52vh] overflow-y-auto">
                  {rowsData.rows.map((row, index) => (
                    <button
                      key={getRowKey(row, index)}
                      onClick={() => setSelectedRowIndex(index)}
                      className={clsx(
                        'w-full border-b border-[var(--color-border)] px-4 py-3 text-left transition-colors last:border-b-0',
                        selectedRowIndex === index
                          ? 'bg-[var(--color-primary)]/10'
                          : 'hover:bg-[var(--color-bg-hover)]',
                      )}
                    >
                      <div className="text-sm font-mono text-[var(--color-text-secondary)]">
                        #{index + 1}
                        {row.id !== undefined && ` · id=${String(row.id)}`}
                      </div>
                      <div className="mt-1 text-sm line-clamp-3">
                        {summarizeRow(row, rowsData.columns)}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)]/30">
                <div className="border-b border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
                  Row Detail
                </div>
                <pre className="m-0 max-h-[52vh] overflow-auto p-4 text-xs leading-6 whitespace-pre-wrap break-words">
                  {selectedRow ? JSON.stringify(selectedRow, null, 2) : 'No row selected'}
                </pre>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
