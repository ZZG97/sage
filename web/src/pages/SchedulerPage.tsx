import { useState, type FormEvent } from 'react';
import dayjs from 'dayjs';
import { clsx } from 'clsx';
import {
  schedulerApi,
  type BuiltinTask,
  type DynamicTask,
} from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { Card, CardTitle, StatValue } from '@/components/Card';

type ScheduleMode = 'cron' | 'oneshot';

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '-';
  return dayjs(timestamp).format('YYYY-MM-DD HH:mm');
}

function KindBadge({ kind }: { kind: DynamicTask['kind'] }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        kind === 'agent'
          ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]'
          : 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]',
      )}
    >
      {kind === 'agent' ? 'Agent' : 'Message'}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const className =
    status === 'active'
      ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
      : status === 'completed'
        ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]'
        : 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';

  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', className)}>
      {status}
    </span>
  );
}

function BuiltinTaskCard({
  task,
  running,
  onRun,
}: {
  task: BuiltinTask;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{task.name}</div>
          <div className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Cron: <code>{task.pattern}</code>
          </div>
        </div>
        <button
          onClick={onRun}
          disabled={running}
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? 'Running...' : 'Run Now'}
        </button>
      </div>
      {task.allowInDev && (
        <div className="mt-3 text-xs text-[var(--color-text-secondary)]">
          可在 development 环境注册
        </div>
      )}
    </div>
  );
}

function DynamicTaskCard({
  task,
  deleting,
  onDelete,
}: {
  task: DynamicTask;
  deleting: boolean;
  onDelete: () => void;
}) {
  const scheduleLabel = task.pattern
    ? `Cron: ${task.pattern}`
    : `Trigger At: ${formatTimestamp(task.trigger_at)}`;

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <KindBadge kind={task.kind} />
            <StatusBadge status={task.status} />
            <span className="font-mono text-xs text-[var(--color-text-secondary)]">{task.id.slice(0, 8)}</span>
          </div>
          {task.title && (
            <div className="mt-3 text-sm text-[var(--color-text-secondary)]">Title: {task.title}</div>
          )}
          <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{task.message}</div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <span>{scheduleLabel}</span>
            <span>Created: {formatTimestamp(task.created_at)}</span>
          </div>
        </div>
        {task.status === 'active' && (
          <button
            onClick={onDelete}
            disabled={deleting}
            className="rounded-lg border border-[var(--color-danger)]/40 px-3 py-2 text-sm text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  );
}

export function SchedulerPage() {
  const [showAll, setShowAll] = useState(false);
  const [kind, setKind] = useState<DynamicTask['kind']>('message');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('cron');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [pattern, setPattern] = useState('0 9 * * 1-5');
  const [triggerAt, setTriggerAt] = useState(dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm'));
  const [submitting, setSubmitting] = useState(false);
  const [runningBuiltin, setRunningBuiltin] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  const {
    data: builtinData,
    loading: builtinLoading,
    error: builtinError,
    refetch: refetchBuiltin,
  } = useQuery(() => schedulerApi.getBuiltinTasks(), [], 15000);

  const {
    data: dynamicData,
    loading: dynamicLoading,
    error: dynamicError,
    refetch: refetchDynamic,
  } = useQuery(() => schedulerApi.getDynamicTasks(showAll), [showAll], 10000);

  const builtinTasks = builtinData?.tasks ?? [];
  const dynamicTasks = dynamicData?.tasks ?? [];

  const stats = {
    visible: dynamicTasks.length,
    active: dynamicTasks.filter((task) => task.status === 'active').length,
    agent: dynamicTasks.filter((task) => task.kind === 'agent').length,
  };

  const handleCreateTask = async (e: FormEvent) => {
    e.preventDefault();

    const content = message.trim();
    if (!content) {
      alert('message / prompt 不能为空');
      return;
    }

    const payload =
      kind === 'agent'
        ? { kind, prompt: content, title: title.trim() || undefined }
        : { kind, message: content };

    if (scheduleMode === 'cron') {
      if (!pattern.trim()) {
        alert('cron pattern 不能为空');
        return;
      }
    } else {
      const ts = dayjs(triggerAt).valueOf();
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        alert('一次性任务时间必须晚于当前时间');
        return;
      }
    }

    setSubmitting(true);
    try {
      await schedulerApi.createDynamicTask({
        ...payload,
        pattern: scheduleMode === 'cron' ? pattern.trim() : undefined,
        triggerAt: scheduleMode === 'oneshot' ? dayjs(triggerAt).valueOf() : undefined,
      });
      setMessage('');
      if (kind === 'agent') setTitle('');
      await refetchDynamic();
    } catch (err: any) {
      alert(err.message || '创建任务失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunBuiltin = async (name: string) => {
    setRunningBuiltin(name);
    try {
      await schedulerApi.runBuiltinTask(name);
      alert(`已触发 ${name}`);
      await Promise.all([refetchBuiltin(), refetchDynamic()]);
    } catch (err: any) {
      alert(err.message || '触发内置任务失败');
    } finally {
      setRunningBuiltin(null);
    }
  };

  const handleDeleteTask = async (id: string) => {
    setDeletingTaskId(id);
    try {
      await schedulerApi.deleteDynamicTask(id);
      await refetchDynamic();
    } catch (err: any) {
      alert(err.message || '删除任务失败');
    } finally {
      setDeletingTaskId(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold">Scheduler</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            管理内置任务和动态提醒；动态任务支持纯文本提醒与 agent 主动执行两种模式。
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetchDynamic()}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm transition-colors hover:bg-[var(--color-bg-hover)]"
          >
            Refresh Tasks
          </button>
          <button
            onClick={() => setShowAll((value) => !value)}
            className={clsx(
              'rounded-lg border px-3 py-2 text-sm transition-colors',
              showAll
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-text)]'
                : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]',
            )}
          >
            {showAll ? 'Showing All' : 'Show Completed'}
          </button>
        </div>
      </div>

      {(builtinError || dynamicError) && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]">
          {builtinError || dynamicError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card>
          <StatValue value={builtinTasks.length} label="Builtin Tasks" />
        </Card>
        <Card>
          <StatValue value={stats.active} label="Active Dynamic" />
        </Card>
        <Card>
          <StatValue value={stats.visible} label={showAll ? 'Visible Tasks' : 'Loaded Active'} />
        </Card>
        <Card>
          <StatValue value={stats.agent} label="Agent Tasks" />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardTitle>Create Dynamic Task</CardTitle>
          <form className="space-y-4" onSubmit={handleCreateTask}>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Task Kind</div>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as DynamicTask['kind'])}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none"
                >
                  <option value="message">Message</option>
                  <option value="agent">Agent</option>
                </select>
              </label>

              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Schedule Mode</div>
                <select
                  value={scheduleMode}
                  onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none"
                >
                  <option value="cron">Cron</option>
                  <option value="oneshot">One Shot</option>
                </select>
              </label>
            </div>

            {kind === 'agent' && (
              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Title</div>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="例如：晚间复盘"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
                />
              </label>
            )}

            <label className="block">
              <div className="mb-2 text-sm text-[var(--color-text-secondary)]">
                {kind === 'agent' ? 'Prompt' : 'Message'}
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                placeholder={
                  kind === 'agent'
                    ? '例如：帮我总结今天的工作，并列出明天最重要的三件事'
                    : '例如：17:30 出门，别忘了带电脑电源'
                }
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
              />
            </label>

            {scheduleMode === 'cron' ? (
              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Cron Pattern</div>
                <input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
                />
                <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                  示例：`0 9 * * 1-5` 工作日 09:00；`30 23 * * *` 每天 23:30。
                </div>
              </label>
            ) : (
              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Trigger Time</div>
                <input
                  type="datetime-local"
                  value={triggerAt}
                  onChange={(e) => setTriggerAt(e.target.value)}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none"
                />
              </label>
            )}

            <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-4">
              <div className="text-xs text-[var(--color-text-secondary)]">
                所有时间按 `Asia/Shanghai` 解释；one-shot 执行后会自动标记为 `completed`。
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Creating...' : 'Create Task'}
              </button>
            </div>
          </form>
        </Card>

        <Card>
          <CardTitle>Builtin Tasks</CardTitle>
          {builtinLoading && builtinTasks.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
          ) : builtinTasks.length === 0 ? (
            <div className="text-sm text-[var(--color-text-secondary)]">No builtin tasks</div>
          ) : (
            <div className="space-y-3">
              {builtinTasks.map((task) => (
                <BuiltinTaskCard
                  key={task.name}
                  task={task}
                  running={runningBuiltin === task.name}
                  onRun={() => handleRunBuiltin(task.name)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardTitle>Dynamic Tasks</CardTitle>
        {dynamicLoading && dynamicTasks.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)]">Loading...</div>
        ) : dynamicTasks.length === 0 ? (
          <div className="text-sm text-[var(--color-text-secondary)]">
            当前没有{showAll ? '' : ' active '}动态任务。
          </div>
        ) : (
          <div className="space-y-3">
            {dynamicTasks.map((task) => (
              <DynamicTaskCard
                key={task.id}
                task={task}
                deleting={deletingTaskId === task.id}
                onDelete={() => handleDeleteTask(task.id)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
