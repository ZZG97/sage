# FreshRSS API Management

Use this file when the request is about listing, grouping, or removing subscriptions already managed by FreshRSS.

## Current Environment

- FreshRSS base URL: `http://127.0.0.1:1211`
- Default user: `zhang`
- Local data dir: `~/deploy/freshrss/data`
- Helper script: `scripts/freshrss_api.py`

The current deployment exposes two relevant APIs:

- `Fever API`: works for listing groups and feeds; convenient for grouped inventory.
- `GReader API`: works end-to-end from this host, including `subscription/list` and `subscription/edit`.

Check the GReader path with:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py check-greader
```

If it prints `FAIL`, do not claim that API unsubscribe is available from this host without extra setup. A pass means
`remove-feed` should be able to use `subscription/edit` directly.

## Preferred Commands

List groups:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-groups
```

List feeds grouped by category:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-feeds
```

List feeds with URLs:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-feeds --show-urls
```

List feeds in one group:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py list-feeds --group Weibo --show-urls
```

Remove one feed:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py remove-feed --title 阿叔特皮
```

If GReader auth is still broken but the user explicitly wants the feed gone now, allow the local fallback:

```bash
python3 ./.claude/skills/rss-manager/scripts/freshrss_api.py remove-feed --title 阿叔特皮 --db-fallback
```

## Removal Rules

- Resolve the target precisely by exact id, exact title, or exact URL.
- Prefer API unsubscribe when `check-greader` passes.
- If `check-greader` fails, say why and avoid silently falling back to DB unless the user accepts local fallback.
- Only use `--db-fallback` when the user wants the change applied immediately and local-owner fallback is acceptable.
- After removal, re-run `list-feeds` or query the specific feed to verify it is gone.

## Notes

- The helper script reads `feverKey`, `apiPasswordHash`, and `salt` from FreshRSS local config files. Do not print those values.
- `remove-feed --db-fallback` deletes from `feed` with SQLite foreign keys enabled, so associated entries cascade the same way FreshRSS does internally.
