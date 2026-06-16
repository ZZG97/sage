# RSS App

The RSS app is Sage's code-side RSS AI worker and generated-feed publisher. RSSHub/FreshRSS operations, subscription inventory, cookies, source quality observations, and reading preferences live in agent memory and the `rss-manager` skill.

## Scope

This document owns durable app boundaries for `src/apps/rss/`:

- RSS AI classification worker.
- `data/rss-ai.db` sidecar state.
- Generated AI feeds served by Sage.
- Refresh policy and Operations metrics.

It does not own subscription operations, cookie refresh, FreshRSS user preferences, or one-off digest procedures.

## Current Model

`src/apps/rss/` reads FreshRSS SQLite state, refreshes candidate source feeds, classifies new entries with a dedicated structured agent flow, stores decisions in `data/rss-ai.db`, and serves generated feeds:

- `/apps/rss/feeds/ai-must-read.xml`
- `/apps/rss/feeds/ai-skim.xml`
- `/apps/rss/feeds/ai-skip.xml`

FreshRSS subscribes to those generated feeds under the `Sage AI` category for Android reading.

Generated feed URLs are excluded from source refresh and classifier input to avoid loops.

## Related Runtime State

- `agent_home/memory/project_sage/rss_app.md`: hot code-side facts and active gaps.
- `agent_home/memory/rss_intake.md`: RSSHub/FreshRSS operations, subscription state, cookies, source quality, and Android reading notes.
- `agent_home/.claude/skills/rss-manager/`: agent procedure docs and helper scripts.
- `docs/operations.md`: Operations metrics and alerting for `rss.ai.refresh`.

## Rules

- The worker should record `rss.ai.refresh` Operations metrics for attempted, succeeded, failed, skipped, new, classified, batch failure, and output-feed counts.
- Generated feeds are the phone-facing path; do not reintroduce original FreshRSS label writes as the primary Android sync mechanism without solving read-state semantics.
- RSSHub/FreshRSS secrets, cookies, and tokens must not be copied into repo docs.
- Subscription quality and source governance should stay in memory or `rss-manager` references, not in this app architecture doc.

## Open Gaps

- Generated feed read-state and item identity semantics can make old generated items reappear as unread.
- Classifier batch failures need stronger retry/backoff and recovered-warning semantics.
- FreshRSS config health checks should catch empty or corrupted user config before Android reading breaks.
