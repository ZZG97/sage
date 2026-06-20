# Sage Log Inspection State

**Status:** Bootstrapped 2026-06-10. Read-only scheduler inspection active.

**Current Loop:** Collect bounded recent Operations/PM2 evidence, classify it,
report a concise summary, and update this state with sanitized conclusions.

**Scheduler Task:** Active dynamic workflow `4c6f13c2-15ab-4788-bf8a-45f83108ac7d`,
title `Sage 日志巡检`, cron `0 10 * * *` Asia/Shanghai. Created 2026-06-10
through local management API. It runs a read-only shell collection step followed
by an agent analysis step that must obey this workstream's README/state.

**Last Inspection:** 2026-06-20 10:00 scheduled read-only pass. Checked recent
Operations rows and PM2 `sage` / `sage-dev` logs from the workflow artifact.
No raw logs were committed.

**Known Patterns:**
- `rss-ai-workflow-timeout`: Dynamic workflow `FreshRSS AI 定时刷新打标`
  runs `bun run rss:ai:refresh -- --feed-limit 20 --limit 80 --since-hours 12`
  with `timeoutSec=1200`. On 2026-06-09 evening it timed out 5 times; stderr
  showed repeated `rss.classify.batch` aborts followed by SIGTERM. Later runs at
  2026-06-09 23:10 and 2026-06-10 08:30 succeeded. Laozhang marked this too old
  to keep watching on 2026-06-16.
- `opencode-startup-unavailable`: On 2026-06-10 startup, OpenCode provider
  health check could not connect and FallbackProvider warned it would retry on
  switch. Treat as provider availability/config watch unless OpenCode is
  expected to be continuously available.
- `codex-backend-stream-disconnect`: On 2026-06-15, built-in and dynamic
  scheduler agent runs failed repeatedly with Codex stream disconnects while
  calling the ChatGPT backend API. Affected daily journal, weekly consolidation,
  the log inspection workflow, and another dynamic workflow. Laozhang confirmed
  this was a recovered network fault on 2026-06-16; no active watch.
- `pm2-ws-certificate-errors`: On 2026-06-16 shortly after midnight, both
  `sage` and `sage-dev` PM2 logs showed repeated websocket connection failures,
  mostly certificate verification errors, plus one connection refusal/timeout
  class event. Laozhang confirmed this was a recovered network fault on
  2026-06-16; no active watch.

**Watch Items:**
- RSS AI refresh reliability: recent 7-day Operations summary on 2026-06-17
  shows 41 warning `rss.ai.refresh` runs and 39 successes. Warnings clustered
  on 2026-06-15 through early 2026-06-16 with entries seen but zero classified;
  later successes resumed through 2026-06-17 08:30. Keep watching recurrence
  before opening a focused RSS reliability fix.
- RSS AI refresh reliability on 2026-06-19: warning recurrence appeared at
  2026-06-18 22:30 with feeds and new entries present but zero classified, plus
  failed AI batches. The 7-day window still shows more successes than warnings,
  and the latest success was 2026-06-19 08:30. Keep as active watch; open a
  focused RSS AI diagnostics/fix turn only after Laozhang confirms.
- RSS AI refresh reliability on 2026-06-20: warning count remains high in the
  7-day window, but latest warning is still 2026-06-18 22:30 and latest success
  is 2026-06-20 08:30. Keep as active watch; do not open code changes without
  Laozhang confirmation.
- PM2 prod/dev error tails were quiet on 2026-06-20 inspection. No new runtime
  log pattern from bounded PM2 evidence.
- OpenCode provider availability: verify intent before fixing. If OpenCode is
  optional, this may be expected fallback noise; if it is primary, inspect
  service health and provider startup dependency in a normal coding turn.

**Log-Level Candidates:**
- Feishu SDK warning `no im.chat.access_event.bot_p2p_chat_entered_v1 handle`
  appeared in both prod and dev error logs. It looks like unsupported event
  noise rather than a Sage application failure. Confirmed to originate from the
  Feishu SDK EventDispatcher default logger; Sage now registers the specific
  `bot_p2p_chat_entered` access event as a known no-op handler.
- HistoryStore legacy migration skip notice appears at startup when explicit
  migration is disabled. Laozhang confirmed lowering the level on 2026-06-18;
  source now logs it at info level. Runtime logs will reflect this after the
  next owner-controlled service restart.

**Fix Candidates:**
- RSS AI batch partial failures: repeated warning runs with new entries but zero
  classified items likely deserve a focused fix if Laozhang confirms RSS AI
  classification should be reliable by default.
- Debug database browser: on 2026-06-17, prod and dev logged
  `/apps/debug/databases` failures with SQLite unable to open a database file.
  Current source appears to skip unreadable database files, so first confirm
  whether the running service has that guard loaded; if it does, inspect stale
  cached handles or incomplete database files. No recurrence was visible in the
  2026-06-18 PM2 error/warn tail. Ask before opening a fix.

**Next Step:** Ask Laozhang before opening code changes. If approved, prioritize
the debug database browser investigation, then RSS AI batch diagnostics if
warnings recur. Network faults confirmed recovered on 2026-06-16; do not keep
active watch unless they recur.
