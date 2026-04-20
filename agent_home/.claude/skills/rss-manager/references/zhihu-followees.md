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

The active feed list is usually:

```text
~/.rsshub/feeds.txt
```

As of the 2026-04-18 check, 11 followee `url_token`s from the canonical file had matching Zhihu people feeds:

```text
xu-ze-qiu, tan-xin-yu-22, hu-ya-cang-yun, wenmiau, zhang-yu-41-8-33, sinya-lee,
valkla123, shi-nian-yi, greatpie, nai-bao-de-da-shu, rwkv-56
```

Recompute this before making changes; do not assume the count is still current.

## Routes

Known local RSSHub Zhihu people routes already used in feeds:

```text
http://127.0.0.1:1200/zhihu/people/answers/<url_token>
http://127.0.0.1:1200/zhihu/people/pins/<url_token>
http://127.0.0.1:1200/zhihu/people/activities/<url_token>
```

Default choice:

- Use `answers` for high-signal answer-focused accounts.
- Use `activities` when the user wants all visible activity, including upvotes and answers; this can be noisy.
- Use `pins` only for accounts whose pins are useful or when already requested.

## Dedup Check

Before adding accounts, compare the canonical tokens against all existing people feeds:

```bash
python3 - <<'PY'
import json, re
from pathlib import Path

src = Path('/Users/zhangzhiguo/workspace/sage/data/zhihu-followees-browser-result.json')
feeds = Path.home() / '.rsshub/feeds.txt'
data = json.loads(src.read_text())
text = feeds.read_text() if feeds.exists() else ''

for f in data.get('followees', []):
    token = f.get('url_token')
    if not token:
        continue
    subscribed = bool(re.search(r'/zhihu/people/[^\\s#]+/' + re.escape(token) + r'(?=\\s|$|#)', text))
    print(('SUB' if subscribed else 'NEW'), token, f.get('name', ''), f.get('follower_count', 0), f.get('headline', ''))
PY
```

## Adding From The Followee List

1. Read the canonical JSON and current `~/.rsshub/feeds.txt`.
2. Deduplicate by `url_token` across all `/zhihu/people/<route>/<token>` variants.
3. Pick a small batch unless the user asks for bulk addition.
4. Add comments with the Zhihu display name.
5. Prefer `answers` first; add `activities` or `pins` only when justified.
6. Validate at least one newly added feed with `curl`.

Example feed block:

```text
# Zhihu followees batch YYYY-MM-DD
# 用户名
http://127.0.0.1:1200/zhihu/people/answers/<url_token>
```

Use `apply_patch` for edits to `~/.rsshub/feeds.txt`; preserve existing comments and order.
