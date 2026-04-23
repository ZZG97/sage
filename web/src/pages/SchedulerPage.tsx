import { useState, type FormEvent } from 'react';
import dayjs from 'dayjs';
import { clsx } from 'clsx';
import {
  schedulerApi,
  type BuiltinTask,
  type DynamicTask,
  type WorkflowPayload,
} from '@/lib/api';
import { useQuery } from '@/lib/hooks';
import { Card, CardTitle, StatValue } from '@/components/Card';

type ScheduleMode = 'cron' | 'oneshot';
const DEFAULT_CRON_PATTERN = '0 9 * * 1-5';
const DEFAULT_WORKFLOW_SPEC = `{
  "version": 1,
  "steps": [
    {
      "id": "fetch",
      "kind": "shell",
      "command": "./.claude/skills/rss-manager/scripts/fetch_items.sh",
      "cwd": "~/workspace/sage/agent_home",
      "timeoutSec": 2400
    },
    {
      "id": "digest",
      "kind": "agent",
      "title": "RSS 定时摘要",
      "prompt": "基于 workflow 上下文中的抓取结果做中文摘要，不要重新抓取。"
    }
  ]
}`;

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '-';
  return dayjs(timestamp).format('YYYY-MM-DD HH:mm');
}

function formatDatetimeLocal(timestamp: number | null): string {
  if (!timestamp) {
    return dayjs().add(1, 'hour').format('YYYY-MM-DDTHH:mm');
  }
  return dayjs(timestamp).format('YYYY-MM-DDTHH:mm');
}

function formatWorkflowPayload(payload: WorkflowPayload | null): string {
  if (!payload) return DEFAULT_WORKFLOW_SPEC;
  return JSON.stringify(payload, null, 2);
}

function KindBadge({ kind }: { kind: DynamicTask['kind'] }) {
  const className =
    kind === 'agent'
      ? 'bg-[var(--color-primary)]/15 text-[var(--color-primary-light)]'
      : kind === 'workflow'
        ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
        : 'bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]';

  const label =
    kind === 'agent'
      ? 'Agent'
      : kind === 'workflow'
        ? 'Workflow'
        : 'Message';

  return (
    <span className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', className)}>
      {label}
    </span>
  );
}

function formatWorkflowStep(step: WorkflowPayload['steps'][number], index: number): string {
  if (step.kind === 'shell') {
    return `${index + 1}. shell: ${step.command}`;
  }
  return `${index + 1}. agent: ${step.prompt}`;
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
  editing,
  updating,
  deleting,
  onEdit,
  onDelete,
}: {
  task: DynamicTask;
  editing: boolean;
  updating: boolean;
  deleting: boolean;
  onEdit: () => void;
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
          {task.kind === 'workflow' && task.payload && (
            <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-hover)]/40 p-3">
              <div className="text-xs uppercase tracking-[0.14em] text-[var(--color-text-secondary)]">Workflow Steps</div>
              <div className="mt-2 space-y-2 text-sm leading-6">
                {task.payload.steps.map((step, index) => (
                  <div key={`${task.id}-${index}`} className="whitespace-pre-wrap break-words">
                    {formatWorkflowStep(step, index)}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-secondary)]">
            <span>{scheduleLabel}</span>
            <span>Created: {formatTimestamp(task.created_at)}</span>
          </div>
        </div>
        {task.status === 'active' && (
          <div className="flex shrink-0 flex-col gap-2">
            <button
              onClick={onEdit}
              disabled={updating || deleting}
              className={clsx(
                'rounded-lg border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                editing
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-text)]'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]',
              )}
            >
              {updating ? 'Saving...' : editing ? 'Editing' : 'Edit'}
            </button>
            <button
              onClick={onDelete}
              disabled={deleting || updating}
              className="rounded-lg border border-[var(--color-danger)]/40 px-3 py-2 text-sm text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)]/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SchedulerPage() {
  const [showAll, setShowAll] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [kind, setKind] = useState<DynamicTask['kind']>('message');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('cron');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [workflowSpec, setWorkflowSpec] = useState(DEFAULT_WORKFLOW_SPEC);
  const [pattern, setPattern] = useState(DEFAULT_CRON_PATTERN);
  const [triggerAt, setTriggerAt] = useState(formatDatetimeLocal(null));
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
  const isEditing = editingTaskId !== null;

  const stats = {
    visible: dynamicTasks.length,
    active: dynamicTasks.filter((task) => task.status === 'active').length,
    agent: dynamicTasks.filter((task) => task.kind === 'agent').length,
    workflow: dynamicTasks.filter((task) => task.kind === 'workflow').length,
  };

  const resetForm = () => {
    setEditingTaskId(null);
    setKind('message');
    setScheduleMode('cron');
    setMessage('');
    setTitle('');
    setWorkflowSpec(DEFAULT_WORKFLOW_SPEC);
    setPattern(DEFAULT_CRON_PATTERN);
    setTriggerAt(formatDatetimeLocal(null));
  };

  const handleEditTask = (task: DynamicTask) => {
    setEditingTaskId(task.id);
    setKind(task.kind);
    setScheduleMode(task.pattern ? 'cron' : 'oneshot');
    setMessage(task.message);
    setTitle(task.title ?? '');
    setWorkflowSpec(formatWorkflowPayload(task.payload));
    setPattern(task.pattern ?? DEFAULT_CRON_PATTERN);
    setTriggerAt(formatDatetimeLocal(task.trigger_at));
  };

  const handleSubmitTask = async (e: FormEvent) => {
    e.preventDefault();

    const content = message.trim();
    if (kind !== 'workflow' && !content) {
      alert('message / prompt 不能为空');
      return;
    }

    let payload: Record<string, unknown>;
    if (kind === 'workflow') {
      let workflow: WorkflowPayload;
      try {
        workflow = JSON.parse(workflowSpec) as WorkflowPayload;
      } catch {
        alert('workflow JSON 解析失败');
        return;
      }
      payload = {
        kind,
        title: title.trim() || undefined,
        description: content || undefined,
        workflow,
      };
    } else if (kind === 'agent') {
      payload = { kind, prompt: content, title: title.trim() || undefined };
    } else {
      payload = { kind, message: content };
    }

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
      const input = {
        ...payload,
        pattern: scheduleMode === 'cron' ? pattern.trim() : undefined,
        triggerAt: scheduleMode === 'oneshot' ? dayjs(triggerAt).valueOf() : undefined,
      };
      if (editingTaskId) {
        await schedulerApi.updateDynamicTask(editingTaskId, input);
      } else {
        await schedulerApi.createDynamicTask(input);
      }
      resetForm();
      await refetchDynamic();
    } catch (err: any) {
      alert(err.message || (editingTaskId ? '更新任务失败' : '创建任务失败'));
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
      if (editingTaskId === id) {
        resetForm();
      }
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
            管理内置任务和动态提醒；动态任务支持 message、agent 与 workflow 三种模式。
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
          <StatValue value={stats.agent} label="Agent Tasks" />
        </Card>
        <Card>
          <StatValue value={stats.workflow} label="Workflow Tasks" />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <Card>
          <CardTitle>{isEditing ? 'Edit Dynamic Task' : 'Create Dynamic Task'}</CardTitle>
          <form className="space-y-4" onSubmit={handleSubmitTask}>
            {isEditing && (
              <div className="rounded-xl border border-[var(--color-primary)]/25 bg-[var(--color-primary)]/10 px-4 py-3 text-sm text-[var(--color-text)]">
                正在编辑任务 <span className="font-mono">{editingTaskId?.slice(0, 8)}</span>。保存后会原地刷新 scheduler 注册项，不会再走删重建。
              </div>
            )}
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
                  <option value="workflow">Workflow</option>
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

            {(kind === 'agent' || kind === 'workflow') && (
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
                {kind === 'agent' ? 'Prompt' : kind === 'workflow' ? 'Description (Optional)' : 'Message'}
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={kind === 'workflow' ? 3 : 6}
                placeholder={
                  kind === 'agent'
                    ? '例如：帮我总结今天的工作，并列出明天最重要的三件事'
                    : kind === 'workflow'
                      ? '例如：先抓 RSS，再让 agent 汇总；不填则自动根据 workflow 生成摘要'
                    : '例如：17:30 出门，别忘了带电脑电源'
                }
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-secondary)]"
              />
            </label>

            {kind === 'workflow' && (
              <label className="block">
                <div className="mb-2 text-sm text-[var(--color-text-secondary)]">Workflow JSON</div>
                <textarea
                  value={workflowSpec}
                  onChange={(e) => setWorkflowSpec(e.target.value)}
                  rows={16}
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm leading-6 text-[var(--color-text)] outline-none"
                />
                <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                  当前仅支持线性 steps；step.kind 只支持 `shell` 与 `agent`。
                </div>
              </label>
            )}

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
              <div className="flex items-center gap-2">
                {isEditing && (
                  <button
                    type="button"
                    onClick={resetForm}
                    disabled={submitting}
                    className="rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (isEditing ? 'Saving...' : 'Creating...') : isEditing ? 'Save Changes' : 'Create Task'}
                </button>
              </div>
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
                editing={editingTaskId === task.id}
                updating={submitting && editingTaskId === task.id}
                deleting={deletingTaskId === task.id}
                onEdit={() => handleEditTask(task)}
                onDelete={() => handleDeleteTask(task.id)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
