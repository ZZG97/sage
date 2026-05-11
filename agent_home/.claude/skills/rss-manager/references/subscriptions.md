# Subscription Management

Use this file when adding, removing, expanding, or debugging RSS subscriptions.

## Feed File

The fetch script reads feeds from:

1. `~/.rsshub/feeds.txt`
2. `rss-manager/feeds.txt` inside the skill directory

Prefer `~/.rsshub/feeds.txt` for user-level subscriptions. Create the directory if missing.

Do not assume `~/.rsshub/feeds.txt` is the source of truth for all current subscriptions. In this workspace, many feeds
have already been migrated into FreshRSS and should be inspected via `scripts/freshrss_api.py` first. Use this file for
legacy/manual RSSHub feed lists that still participate in the old fetch pipeline.

Format:

```text
# Group or reason
http://localhost:1200/xueqiu/user/8152922548 # 今日话题
```

Keep comments useful: source name, account/topic, or why it matters. Avoid noisy notes.

## Local RSSHub URLs

Use local RSSHub when available:

```text
http://localhost:1200/<route>
```

If the reader runs on another device, `localhost` refers to that device, not this Mac. Use the Mac LAN address or a reachable reverse proxy instead.

Do not rely on `https://rsshub.app` for production subscriptions; public instances may be rate-limited or blocked.

## Adding A Subscription

1. Identify the target: site, account, topic, keyword, column, collection, or timeline.
2. Find the RSSHub route from official docs or source if the route is not obvious.
3. Build a local RSSHub URL.
4. Test it with `curl` and inspect title/item count.
5. Add it to `~/.rsshub/feeds.txt` with a short comment.
6. Run the digest fetch or a targeted validation.

Use primary sources for route details: RSSHub docs or RSSHub source code.

For Zhihu followees, read `references/zhihu-followees.md` before editing feeds. It records the canonical followee
inventory file, current partial-subscription state, and the dedup rules for adding more accounts.

## Xueqiu Examples

User dynamics:

```text
http://localhost:1200/xueqiu/user/<user_id>
```

Type filters:

```text
http://localhost:1200/xueqiu/user/<user_id>/0   # 原发布
http://localhost:1200/xueqiu/user/<user_id>/2   # 长文
http://localhost:1200/xueqiu/user/<user_id>/4   # 问答
http://localhost:1200/xueqiu/user/<user_id>/9   # 热门
http://localhost:1200/xueqiu/user/<user_id>/11  # 交易
```

The user ID comes from:

```text
https://xueqiu.com/u/<user_id>
```

Logged-in follow timeline is different:

```text
http://localhost:1200/xueqiu/timeline/-1
```

That route requires `XUEQIU_COOKIES` and should only be configured if the user explicitly wants account-level follow timeline.

## Expanding Coverage

When the user asks for broader subscriptions, propose categories before adding many feeds:

- Work and AI engineering: official blogs, model providers, infra, databases, observability.
- Personal information diet: trusted analysts, newsletters with RSS, saved sites.
- Finance/markets: Xueqiu accounts, company announcements, sector keywords.
- Local project tracking: GitHub releases, changelogs, docs feeds.
- Zhihu followees: select from the canonical followee inventory; add in small batches and deduplicate by `url_token`.

Keep the feed set high-signal. Avoid adding low-quality feeds just to increase volume.

## Removal And Cleanup

Before removing feeds, search exact URLs and comments:

```bash
rg -n 'keyword|domain|route' ~/.rsshub/feeds.txt
```

Remove stale feeds with `apply_patch`. Preserve comments and ordering unless cleanup is requested.

If the request is to remove or inspect a feed already managed by FreshRSS, read `references/freshrss-api.md` and use:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-feeds --show-urls
```

Only edit `~/.rsshub/feeds.txt` when the target really lives in that file.
