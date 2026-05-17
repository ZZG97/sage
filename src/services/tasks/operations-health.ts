import { getOperationsService, type OperationRun } from '../../apps/operations/service';
import type { TaskContext } from '../task-scheduler';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function formatAge(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / 60000)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

function describeRun(run: OperationRun): string {
  const age = formatAge(Date.now() - run.started_at);
  const duration = run.duration_ms == null ? 'running' : `${(run.duration_ms / 1000).toFixed(1)}s`;
  const summary = run.summary ? ` — ${run.summary}` : '';
  return `- ${run.operation_type}/${run.operation_name}: ${run.status}, ${age} ago, ${duration}${summary}`;
}

export async function operationsHealthCheck(ctx: TaskContext): Promise<void> {
  const operations = getOperationsService();
  const messages: string[] = [];

  const problemRuns = operations.listUnalertedProblemRuns(8);
  if (problemRuns.length > 0) {
    messages.push([
      'Operations 发现失败/异常任务：',
      ...problemRuns.map(describeRun),
    ].join('\n'));
  }

  const stuckRuns = operations.listStuckRuns(2 * HOUR, 5);
  if (stuckRuns.length > 0 && operations.shouldSendAlert('stuck-runs', 6 * HOUR)) {
    messages.push([
      'Operations 发现长时间 running 的任务：',
      ...stuckRuns.map(describeRun),
    ].join('\n'));
  }

  const rssLastRun = operations.getLastRun('rss.ai.refresh');
  if (rssLastRun) {
    const rssLastSuccess = operations.getLastSuccessfulRun('rss.ai.refresh');
    const lastSuccessAt = rssLastSuccess?.finished_at ?? 0;
    const maxAge = 3.5 * HOUR;
    if (lastSuccessAt > 0 && Date.now() - lastSuccessAt > maxAge) {
      const alertKey = `stale:rss.ai.refresh:${Math.floor(lastSuccessAt / maxAge)}`;
      if (operations.shouldSendAlert(alertKey, 6 * HOUR)) {
        messages.push(`RSS AI refresh 已 ${formatAge(Date.now() - lastSuccessAt)} 没有成功完成。最近一次状态：${rssLastRun.status}${rssLastRun.summary ? ` — ${rssLastRun.summary}` : ''}`);
      }
    }
  }

  if (messages.length === 0) {
    ctx.logger.info('Operations health check: no alerts');
    return;
  }

  const text = `⚠️ Sage Operations 告警\n\n${messages.join('\n\n')}`;
  if (!ctx.sendMessageToOwner) {
    ctx.logger.warn(text);
    return;
  }

  await ctx.sendMessageToOwner(text);
  operations.markRunsAlerted(problemRuns.map((run) => run.id));
}
