# Sage Log Inspection State

**Status:** Bootstrapped 2026-06-10. Read-only scheduler inspection active.

**Current Loop:** Collect bounded recent Operations/PM2 evidence, classify it,
report a concise summary, and update this state with sanitized conclusions.

**Scheduler Task:** Active dynamic workflow `4c6f13c2-15ab-4788-bf8a-45f83108ac7d`,
title `Sage 日志巡检`, cron `0 10 * * *` Asia/Shanghai. Created 2026-06-10
through local management API. It runs a read-only shell collection step followed
by an agent analysis step that must obey this workstream's README/state.

**Last Inspection:** 2026-06-10 10:00 scheduled read-only pass. Checked recent
Operations rows and PM2 `sage` / `sage-dev` logs. No raw logs were committed.

**Known Patterns:**
- `rss-ai-workflow-timeout`: Dynamic workflow `FreshRSS AI 定时刷新打标`
  runs `bun run rss:ai:refresh -- --feed-limit 20 --limit 80 --since-hours 12`
  with `timeoutSec=1200`. On 2026-06-09 evening it timed out 5 times; stderr
  showed repeated `rss.classify.batch` aborts followed by SIGTERM. Later runs at
  2026-06-09 23:10 and 2026-06-10 08:30 succeeded, so this is not a current
  total outage.
- `opencode-startup-unavailable`: On 2026-06-10 startup, OpenCode provider
  health check could not connect and FallbackProvider warned it would retry on
  switch. Treat as provider availability/config watch unless OpenCode is
  expected to be continuously available.

**Watch Items:**
- RSS AI refresh reliability: recent 7-day Operations summary shows 9 warning
  `rss.ai.refresh` runs and 5 failed dynamic workflow runs. Continue watching
  recurrence before changing schedule, batch size, timeout, or provider behavior.
- OpenCode provider availability: verify intent before fixing. If OpenCode is
  optional, this may be expected fallback noise; if it is primary, inspect
  service health and provider startup dependency in a normal coding turn.

**Log-Level Candidates:**
- Feishu SDK warning `no im.chat.access_event.bot_p2p_chat_entered_v1 handle`
  appeared in `sage-error.log`. It looks like unsupported event noise rather
  than a Sage application failure. Candidate for suppression or level routing
  later if it recurs.
- HistoryStore legacy migration skip warning appears at startup when explicit
  migration is disabled. If routine, consider lower level or route out of error
  log; do not change automatically from this workstream.

**Fix Candidates:**
- Operations ledger hygiene after shell timeout: the timed-out RSS workflow left
  several `rss.ai.refresh` operation rows in `running`. This may be expected when
  the worker process is killed before it can finish its own operation handle, but
  it pollutes health checks. If recurrence continues, inspect RSS worker
  cancellation/finalization and workflow timeout behavior.

**Next Step:** Run one more manual inspection after the next RSS refresh window.
If the same timeout pattern recurs, ask Laozhang whether to open a focused RSS
reliability fix instead of changing code from this workstream automatically.
