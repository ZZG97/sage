import { useState } from 'react';
import { management, type SystemStatus } from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { Card, CardTitle, StatValue } from '@/components/Card';
import { clsx } from 'clsx';

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function ManagementPage() {
  const { data: status, loading, refetch } = useQuery<SystemStatus>(
    () => management.getStatus(),
    [],
    5000, // 5s 自动刷新
  );

  const [switching, setSwitching] = useState(false);

  if (loading && !status) {
    return <div className="text-[var(--color-text-secondary)]">Loading...</div>;
  }

  if (!status) {
    return <div className="text-[var(--color-danger)]">Failed to load status</div>;
  }

  const handleSwitchProvider = async (name: string) => {
    if (name === status.activeProvider || switching) return;
    setSwitching(true);
    try {
      await management.switchProvider(name);
      await refetch();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSwitching(false);
    }
  };

  const handleToggleFallback = async () => {
    try {
      await management.setFallback(!status.autoFallbackEnabled);
      await refetch();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <h2 className="text-xl font-bold">System Management</h2>

      {/* Status Overview */}
      <Card>
        <CardTitle>Status</CardTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatValue
            value={status.isRunning ? 'Running' : 'Stopped'}
            label="Service"
            color={status.isRunning ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}
          />
          <StatValue value={formatUptime(status.uptime)} label="Uptime" />
          <StatValue value={status.sessionCount} label="Sessions" />
          <StatValue
            value={status.activeCards}
            label="Active Cards"
            color={status.activeCards > 0 ? 'text-[var(--color-warning)]' : undefined}
          />
        </div>
        {status.isDraining && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-[var(--color-warning)]/10 text-[var(--color-warning)] text-sm">
            Service is draining (shutting down)...
          </div>
        )}
      </Card>

      {/* Provider Management */}
      <Card>
        <CardTitle>Providers</CardTitle>
        <div className="space-y-3">
          {status.availableProviders.map((name) => {
            const isActive = name === status.activeProvider;
            return (
              <button
                key={name}
                onClick={() => handleSwitchProvider(name)}
                disabled={isActive || switching || !status.isFallback}
                className={clsx(
                  'w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-all text-left',
                  isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                    : 'border-[var(--color-border)] hover:border-[var(--color-primary-light)] hover:bg-[var(--color-bg-hover)]',
                  (isActive || !status.isFallback) && 'cursor-default',
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={clsx(
                      'w-2.5 h-2.5 rounded-full',
                      isActive ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-secondary)]/30',
                    )}
                  />
                  <span className="font-medium">{name}</span>
                </div>
                {isActive && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-primary)] text-white">
                    Active
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!status.isFallback && (
          <p className="mt-2 text-xs text-[var(--color-text-secondary)]">
            Single provider mode — switching unavailable
          </p>
        )}
      </Card>

      {/* Auto Fallback */}
      <Card>
        <CardTitle>Auto Fallback</CardTitle>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm">Automatic failover to backup providers</p>
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
              When enabled, if the active provider fails, requests automatically route to the next available provider
            </p>
          </div>
          <button
            onClick={handleToggleFallback}
            disabled={!status.isFallback}
            className={clsx(
              'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent transition-colors',
              status.autoFallbackEnabled ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]',
              !status.isFallback && 'opacity-50 cursor-not-allowed',
            )}
          >
            <span
              className={clsx(
                'inline-block h-5 w-5 rounded-full bg-white transition-transform',
                status.autoFallbackEnabled ? 'translate-x-5.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      </Card>
    </div>
  );
}
