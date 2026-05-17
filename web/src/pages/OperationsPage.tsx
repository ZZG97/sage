import { Card, CardTitle, StatValue } from '@/components/Card';
import { operationsApi, type OperationRun, type OperationStatus } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { clsx } from 'clsx';

function formatTime(value: number | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusClass(status: OperationStatus): string {
  if (status === 'success') return 'bg-[var(--color-success)]/15 text-[var(--color-success)]';
  if (status === 'warning') return 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]';
  if (status === 'failed') return 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';
  if (status === 'running') return 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]';
  return 'bg-[var(--color-border)] text-[var(--color-text-secondary)]';
}

function metricPreview(run: OperationRun): string {
  const entries = Object.entries(run.metrics);
  if (entries.length === 0) return '-';
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

function MetricsBlock({ run }: { run: OperationRun }) {
  const entries = Object.entries(run.metrics);
  if (entries.length === 0) {
    return <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">-</div>;
  }

  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-mono text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text)]">
        {metricPreview(run)}
        {entries.length > 4 ? ` ... +${entries.length - 4}` : ''}
      </summary>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
        {entries.map(([key, value]) => (
          <div
            key={key}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs"
          >
            <span className="text-[var(--color-text-secondary)]">{key}</span>
            <span className="mx-1 text-[var(--color-text-secondary)]">=</span>
            <span>{String(value)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function RunRow({ run }: { run: OperationRun }) {
  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="py-3 pr-3">
        <div className="font-medium">{run.operation_type}</div>
        <div className="text-xs text-[var(--color-text-secondary)]">{run.operation_name}</div>
      </td>
      <td className="py-3 pr-3">
        <span className={clsx('inline-flex rounded px-2 py-0.5 text-xs font-medium', statusClass(run.status))}>
          {run.status}
        </span>
      </td>
      <td className="py-3 pr-3 text-sm text-[var(--color-text-secondary)]">{run.trigger_type}</td>
      <td className="py-3 pr-3 text-sm">{formatTime(run.started_at)}</td>
      <td className="py-3 pr-3 text-sm">{formatDuration(run.duration_ms)}</td>
      <td className="py-3 text-sm">
        <div>{run.summary || '-'}</div>
        <MetricsBlock run={run} />
        {run.error && (
          <div className="mt-1 text-xs text-[var(--color-danger)] break-all">{run.error}</div>
        )}
      </td>
    </tr>
  );
}

export function OperationsPage() {
  const { data: summaryData, loading: summaryLoading, error: summaryError } = useQuery(
    () => operationsApi.getSummary(),
    [],
    10_000,
  );
  const { data: runsData, loading: runsLoading, error: runsError } = useQuery(
    () => operationsApi.getRuns(80),
    [],
    10_000,
  );

  const runs = runsData?.runs ?? [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h2 className="text-xl font-bold">Operations</h2>

      {(summaryError || runsError) && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
          {summaryError || runsError}
        </div>
      )}

      <Card>
        <CardTitle>Last 24 Hours</CardTitle>
        {summaryLoading && !summaryData ? (
          <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-4">
            <StatValue value={summaryData?.total ?? 0} label="Total" />
            <StatValue value={summaryData?.running ?? 0} label="Running" color="text-[var(--color-primary-light)]" />
            <StatValue value={summaryData?.success ?? 0} label="Success" color="text-[var(--color-success)]" />
            <StatValue value={summaryData?.warning ?? 0} label="Warning" color="text-[var(--color-warning)]" />
            <StatValue value={summaryData?.failed ?? 0} label="Failed" color="text-[var(--color-danger)]" />
            <StatValue value={summaryData?.cancelled ?? 0} label="Cancelled" />
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Recent Runs</CardTitle>
        {runsLoading && runs.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)]">No operation runs yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-xs uppercase text-[var(--color-text-secondary)]">
                <tr>
                  <th className="pb-2 pr-3 font-medium">Operation</th>
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 pr-3 font-medium">Trigger</th>
                  <th className="pb-2 pr-3 font-medium">Started</th>
                  <th className="pb-2 pr-3 font-medium">Duration</th>
                  <th className="pb-2 font-medium">Summary</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
