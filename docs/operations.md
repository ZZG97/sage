# Sage Operations Observability

Operations is Sage's lightweight run ledger for background work and other long-running flows. It answers: did this thing run, did it finish, how long did it take, what did it process, and what broke.

## What Is Recorded

Runs are stored in `data/operations.db`, table `operation_runs`.

Core fields:

- `operation_type`: stable machine name, for example `rss.ai.refresh`.
- `operation_name`: human-readable name or task id.
- `trigger_type`: `scheduler`, `feishu`, `http`, or `manual`.
- `status`: `running`, `success`, `warning`, `failed`, or `cancelled`.
- `started_at`, `finished_at`, `duration_ms`.
- `summary`: short human-readable result.
- `metrics_json`: small key/value counters and gauges.
- `error`: compact failure detail.
- `metadata_json`: low-cardinality extra context.
- `request_id`, `trace_id`: request-context correlation when present.
- `alerted_at`: set after health check sends an alert for a problem run.

UI and API:

- Web: `/operations`
- Summary API: `/apps/operations/summary`
- Runs API: `/apps/operations/runs?limit=50`
- Filter by type: `/apps/operations/runs?type=rss.ai.refresh`

## Automatic Scheduler Coverage

`TaskScheduler.processJob()` records every scheduled job automatically.

Built-in task examples:

- `scheduler.builtin / daily-journal`
- `scheduler.builtin / system-prompt-sync`
- `scheduler.builtin / operations-health-check`

Dynamic task examples:

- `scheduler.dynamic.message / <task_id>`
- `scheduler.dynamic.agent / <task_id>`
- `scheduler.dynamic.workflow / <task_id>`

If new work is implemented as a scheduler builtin or dynamic task, no extra Operations code is required for basic success/failure/duration visibility.

## Manual Integration

Use manual instrumentation for non-scheduler flows, or when a scheduler task needs domain metrics.

```ts
import { getOperationsService } from '../operations/service';

const run = getOperationsService().startRun({
  operationType: 'domain.action',
  operationName: 'Domain action',
  metadata: {
    lowCardinalityKey: 'value',
  },
});

try {
  run.metric('processed_count', processedCount);
  run.metric('failed_count', failedCount);

  if (failedCount > 0) {
    run.warn(`${failedCount} items failed`);
  }

  run.success({
    summary: `processed=${processedCount}, failed=${failedCount}`,
  });
} catch (error) {
  run.failure(error);
  throw error;
}
```

Rules:

- Use stable `operationType`; do not include ids or timestamps in it.
- Put ids or task-specific names in `operationName` or `metadata`.
- Keep `summary` short. It should explain the run in one line.
- Keep metrics numeric or simple booleans/strings.
- Record counts that help locate the broken stage: attempted, succeeded, failed, skipped, produced.
- Call `warn()` for degraded success. Health check alerts warning runs.
- Always rethrow after `failure(error)` unless the caller intentionally handles the error.

## RSS Example

`RssAiService.runOnce()` records `rss.ai.refresh` with these metrics:

- `feed_attempted`, `feed_success`, `feed_failed`, `feed_skipped`
- `new_articles`
- `entries_seen`, `entries_classified`
- `ai_batch_count`, `ai_batch_failed`
- `must_read_count`, `skim_count`, `skip_count`
- `output_feed_attempted`, `output_feed_failed`

Typical summary:

```text
feeds=20, new=1, classified=1, output=3
```

Meaning:

- Refreshed 20 input feeds.
- FreshRSS found 1 new article.
- AI classified 1 article.
- Refreshed 3 generated output feeds: must-read, skim, skip.

## Alerts

`operations-health-check` runs every 10 minutes and sends Feishu alerts for:

- Unalerted `failed` or `warning` runs.
- `running` runs older than 2 hours.
- `rss.ai.refresh` with no successful run for more than 3.5 hours.

Alerting is intentionally simple. Add domain-specific checks only when a real repeated failure mode appears.
