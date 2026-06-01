# Zhihu Followees

Use this file when the user asks to inspect, subscribe to, or continue adding accounts from Laozhang's Zhihu followee list.

## Canonical File

The canonical inventory is:

```text
/Users/zhangzhiguo/workspace/sage/data/zhihu-followees-browser-result.json
```

Treat it as the source snapshot. Do not move it into the skill directory and do not edit it when adding subscriptions.

Current observed structure:

```json
{
  "fetched_at": "2026-04-16T20:03:50.128Z",
  "me": {
    "name": "断臂残猿",
    "url_token": "zhang-zhi-guo-28-58",
    "id": "d715a1a3e17a4512c1cf67fd76620bd8"
  },
  "count": 130,
  "pages": [],
  "followees": []
}
```

Each `followees[]` item has:

```text
name, url_token, id, headline, follower_count, answer_count, articles_count, user_type, is_following
```

Use `url_token` for RSSHub routes. Do not use the internal `id` in RSSHub feed URLs.
Use `name` as the display name when attributing Zhihu people feed items, unless the item title/description explicitly shows
a more specific author/display name.

## Current Subscription State

FreshRSS is the primary reader/state store. Inspect current subscriptions first:

```text
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-feeds --group Zhihu --show-urls
```

The subscription tracking state is:

```text
.claude/skills/rss-manager/data/zhihu-followee-subscription-state.json
```

It records tokens that have ever entered RSS, the latest added batch, and canonical followees that have never entered RSS.
As of 2026-05-28, 24 canonical followee tokens have entered RSS at least once and 109 canonical followees remain never-subscribed.
Removed tokens do not become "never subscribed" again.

Current 2026-05-28 policy:

- Remove `diygod`.
- Keep `rwkv-56` / momo as `activities` only.
- For other selected Zhihu followees, subscribe as `answers + pins` by default.
- Add future batches from `never_subscribed_remaining` in the tracking state unless Laozhang gives a different priority.

## Routes

Known local RSSHub Zhihu people routes already used in feeds:

```text
http://127.0.0.1:1200/zhihu/people/answers/<url_token>
http://127.0.0.1:1200/zhihu/people/pins/<url_token>
http://127.0.0.1:1200/zhihu/people/activities/<url_token>
```

Default choice:

- Use `answers + pins` for selected followees by default.
- Use `activities` when the user wants all visible activity, including upvotes and answers; this can be noisy.
- Use `pins` alone only when answers are not useful.

## Dedup Check

Before adding accounts, compare the canonical tokens against FreshRSS plus the tracking state:

```bash
python3 - <<'PY'
import json, re
from pathlib import Path

src = Path('/Users/zhangzhiguo/workspace/sage/data/zhihu-followees-browser-result.json')
state = Path('.claude/skills/rss-manager/data/zhihu-followee-subscription-state.json')
data = json.loads(src.read_text())
subscribed = set(json.loads(state.read_text()).get('ever_subscribed_tokens_after_2026_05_28', [])) if state.exists() else set()

for f in data.get('followees', []):
    token = f.get('url_token')
    if not token:
        continue
    print(('EVER' if token in subscribed else 'NEVER'), token, f.get('name', ''), f.get('follower_count', 0), f.get('headline', ''))
PY
```

## Adding From The Followee List

1. Read the canonical JSON, current FreshRSS Zhihu feeds, and the tracking state JSON.
2. Deduplicate by `url_token` across all `/zhihu/people/<route>/<token>` variants.
3. Pick a small batch unless the user asks for bulk addition.
4. Use the Zhihu display name as the FreshRSS title.
5. Add `answers + pins` unless the user specifies another route policy.
6. Validate at least one newly added feed with `curl`.
7. Update `.claude/skills/rss-manager/data/zhihu-followee-subscription-state.json` after the import.
