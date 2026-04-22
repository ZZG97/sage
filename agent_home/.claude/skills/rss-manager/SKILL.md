---
name: rss-manager
description: >
  Manage RSS and RSSHub-backed information intake. Use when the user says "读一下RSS", "帮我汇总今天的订阅",
  "RSS digest", "今日资讯", "信息汇总", asks to read/analyze RSS feeds, add/remove/expand subscriptions,
  create RSSHub routes for sites/accounts/topics, modify or debug a local RSSHub deployment, or organize fetched RSS
  content into a digest. This skill covers RSSHub config, subscription scope management, fetch/dedup/split,
  analysis, and final reporting. Do not trigger for a one-off web lookup unless the user wants it added to RSS
  intake or included in a feed digest workflow.
user_invocable: true
---

# RSS Manager Skill

Use this skill for the user's RSS information pipeline: local RSSHub configuration, subscription list maintenance,
feed fetching, deduplication, content analysis, and digest reporting.

## Progressive Disclosure

Read only the reference needed for the user's current request:

- RSSHub deployment/config changes, route debugging, local instance checks: `references/rsshub-config.md`
- Adding/removing feeds, expanding subscription coverage, turning sites/accounts into RSSHub URLs: `references/subscriptions.md`
- Zhihu followee inventory, partially subscribed Zhihu accounts, batch additions from the followee list: `references/zhihu-followees.md`
- Running the digest, deduplicating, splitting work, summarizing and reporting fetched content: `references/content-digest.md`

If a request spans multiple areas, read them in this order: config first, subscriptions second, digest last.

## Quick Routing

- "RSSHub 跑不起来", "改 RSSHub 配置", "雪球路由 503", "换镜像", "加 cookie": read `references/rsshub-config.md`.
- "订阅某个人/站点/关键词", "增加订阅范围", "把这些源加进去", "RSSHub 怎么订阅 X": read `references/subscriptions.md`.
- "知乎关注列表", "继续加知乎关注", "从我的知乎关注里挑订阅": read `references/zhihu-followees.md` after `references/subscriptions.md`.
- "读一下 RSS", "今日资讯", "汇总订阅", "整理今天内容": read `references/content-digest.md`.

## Current Data Flow

The digest entry point is:

```bash
CHUNKS=$(./.claude/skills/rss-manager/scripts/fetch_items.sh)
```

The script reads feeds from `~/.rsshub/feeds.txt` first, then skill-local `feeds.txt`, deduplicates against
`data/pushed.csv`, and writes JSONL chunks to `data/chunks/`. Weibo feeds are rate-limited by default:
`RSS_WEIBO_FETCH_DELAY_SECONDS=30` with `RSS_WEIBO_FETCH_JITTER_SECONDS=5` random jitter, so each interval is 25-35s by
default. `RSS_WEIBO_MAX_CONSECUTIVE_FAILURES=3` skips remaining Weibo feeds for the current run after consecutive failures
while continuing later non-Weibo feeds.

Scheduler workflow integration (2026-04-22):

- Manual/ad-hoc digest still starts from `fetch_items.sh` as above.
- Sage scheduler may now run RSS as a `workflow`: step 1 shell runs `fetch_items.sh`, step 2 agent receives stdout/stderr,
  chunk paths, and artifact file paths from the workflow context.
- When the scheduler/workflow already provides fetch artifacts, do **not** rerun `fetch_items.sh`; analyze the provided
  outputs directly and treat the fetch step as already completed.

## Error Handling

- Do not expose cookie/token values from `.env`, RSSHub config, or browser sessions. Redact secrets in summaries.
- Partial feed fetch failure: continue with other feeds and report failed source count.
- All feed fetches fail: report fetch failure explicitly; do not say "no new content".
- No new items: output `今日没有新内容`.
- Config changes: validate with health checks and one representative feed URL.
