# RSS Link Lookup

Use this when Laozhang provides an original article/post URL and wants to discuss the content, inspect the original RSS
record, or give feedback on Sage RSS AI labels such as `必读` / `可看` / `略过`.

## Data Sources

- FreshRSS original entries: `/Users/zhangzhiguo/deploy/freshrss/data/users/zhang/db.sqlite`, table `entry`.
- Sage RSS AI decisions: `/Users/zhangzhiguo/workspace/sage/data/rss-ai.db`, table `processed_entries`.
- Generated Sage AI feeds duplicate original entries with AI summary/reason in FreshRSS; prefer the original source feed
  entry when discussing content, and use `processed_entries` for priority/reason.

## Lookup Flow

1. Extract a stable id from the URL when possible.
   - X/Twitter: status id from `/status/<id>`.
   - Other sources: use the full URL or a distinctive path fragment.
2. Query FreshRSS first for original title/content/feed/author/date.
3. Query `rss-ai.db` for AI priority/topics/reason/summary.
4. If both original source entry and generated output feed entry exist, treat the source feed entry as canonical.
5. When discussing label quality, separate content judgment from classifier/rule failure.

## FreshRSS Query

```bash
sqlite3 -json /Users/zhangzhiguo/deploy/freshrss/data/users/zhang/db.sqlite \
"select e.id,e.title,e.author,e.content,e.link,e.date,e.id_feed,f.name as feed_name
 from entry e left join feed f on e.id_feed=f.id
 where e.link like '%STATUS_OR_URL_FRAGMENT%'
    or e.guid like '%STATUS_OR_URL_FRAGMENT%';"
```

## AI Decision Query

```bash
sqlite3 /Users/zhangzhiguo/workspace/sage/data/rss-ai.db \
"select entry_id, feed_id, guid, link, priority, topics_json, confidence, reason, summary, processed_at
 from processed_entries
 where link like '%STATUS_OR_URL_FRAGMENT%'
    or guid like '%STATUS_OR_URL_FRAGMENT%';"
```

## Efficiency

The fragment queries use leading-wildcard `LIKE`, so SQLite scans the tables. This is acceptable for ad-hoc lookup at the
current scale. If this becomes a frequent product feature, implement URL normalization and exact-match lookup:

- Parse canonical ids such as X/Twitter status ids.
- Generate known URL variants, e.g. `x.com` and `twitter.com`.
- Add or rely on indexes for `entry(link)`, `entry(guid)`, `processed_entries(link)`, and `processed_entries(guid)`.
- Query with `link in (...) or guid in (...)` instead of leading-wildcard `LIKE`.

## Label Feedback Notes

- Do not automatically accept the existing AI label. Inspect the original content and the AI reason.
- For user-selected feeds, short fragmented posts can still matter; judge repeated positions, assumptions, and watchable
  signals.
- Life-topic items should not be skipped solely for being outside AI/investment/engineering when they contain clear
  mechanism, actionable judgment, counter-intuition, or transferable process insight. Prefer `skim` for that class unless
  it is off-topic trivia or pure emotion.
- Keep claims marked as opinion when the post gives a strong judgment without external evidence.
