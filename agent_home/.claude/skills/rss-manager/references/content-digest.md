# Content Digest Workflow

Use this file when reading, organizing, summarizing, or reporting RSS content.

## Fetch

Run:

```bash
CHUNKS=$(./.claude/skills/rss-manager/scripts/fetch_items.sh)
```

If Sage scheduler/workflow already ran the fetch step and provided chunk paths or fetch artifact paths in the prompt/context,
do not rerun the fetch command. Reuse the provided outputs directly and treat the fetch phase as already completed.

The script:

- Reads feed URLs from `~/.rsshub/feeds.txt` or skill-local `feeds.txt`.
- Fetches all RSS feeds.
- Preserves feed-level and item-level metadata when present, including `source_title`, `source_link`,
  `source_description`, `source_author`, `source_contact`, `item_author`, plus a best-effort `author` fallback and
  `author_source`.
- Rate-limits Weibo feeds by default: `RSS_WEIBO_FETCH_DELAY_SECONDS=30` with
  `RSS_WEIBO_FETCH_JITTER_SECONDS=5`, so each interval is 25-35s by default; after
  `RSS_WEIBO_MAX_CONSECUTIVE_FAILURES=3` consecutive Weibo failures, skips remaining Weibo feeds for the current run and
  continues later non-Weibo feeds.
- Deduplicates against `data/pushed.csv` using `guid`.
- Writes chunk files, 10 items per chunk, to `data/chunks/`.
- Outputs absolute chunk file paths to stdout, one per line.

Exit codes:

- `0`: success; may output nothing if no new items.
- `1`: no feeds file found.
- `2`: all feed fetches failed.
- `3`: another RSS run is in progress.

## Analyze

Read JSONL lines as-is; one JSON object per line.

Use this decision tree:

1. No chunk files: output `今日没有新内容`, stop.
2. 1-2 chunk files, up to 20 items: analyze inline.
3. 3+ chunk files: use at most 3 subagents if subagents are explicitly allowed in the current environment; otherwise merge batches and analyze inline.

For each item, extract:

- What it is about.
- Why it might matter to the user.
- Whether it suggests an action, follow-up, or watch item.

Before attribution, prefer `author`, then raw `item_author` / `source_author` / `source_title`, then explicit display names
that appear in item title/description/content. For Zhihu people feeds, use
`references/zhihu-followees.md` and its canonical inventory to map `url_token` to `name` when item content is not explicit.
Use skill-local `references/source-aliases.md` only for exceptions not derivable from content or canonical inventories.
RSSHub feed paths, Zhihu slugs, numeric Xueqiu ids, and X/Twitter handles may not equal the public display name.

Prefer signal over coverage. Group similar items instead of repeating summaries.

User-specific RSS preferences:

- Current subscription categories: Tech/AI-oriented Zhihu activities and pins; Zhihu daily/pin daily/weekly; selected Zhihu
  followees; selected Xueqiu followees. `zhihu/hot` was removed because it was broad, stale, and low-signal.
- Xueqiu `metalslime` often posts fragmented replies, but the account is important to Laozhang. Do not dismiss these items as
  low-signal only because they are replies. Cluster the fragments by topic first, then extract useful investment or macro
  claims, especially repeated views on sectors, demographics, consumption, energy, AI infrastructure, and market structure.
- X/Twitter `bboczeng` ("bobo") is followed mainly for investment-related views. Show these items when they discuss investing,
  markets, AI infrastructure, semiconductors, crypto, long-term allocation, or portfolio tactics, even if the tone is casual
  or opinionated. Separate factual claims from personal views and mark unverified market/news claims as such.
- Track source quality during each digest. If a feed repeatedly produces low-signal, stale, noisy, duplicate, or off-topic
  items, mention it in the report and suggest whether to remove, limit, or keep watching the source.

## Analysis Prompt

Use this prompt for batch analysis when delegating is allowed:

```text
Analyze the following RSS items for Laozhang.

For each high-signal item, extract:
- What happened or what was published
- Why it matters to a server-side developer building Sage and tracking AI/productivity shifts
- Any concrete follow-up worth doing

Then provide:
- A brief overall summary
- Top items with links
- Items that can be ignored

RSS items:
{BATCH_CONTENT}
```

## Report Structure

Write concise Chinese by default.

Use this structure:

```text
今日资讯（N 条新内容）

最值得看
- [title](url): one-line reason.

主题归纳
- Topic: concise synthesis across related items.

可忽略
- Low-signal category or source, with reason.

后续动作
- Concrete next action if any.

来源: X 个订阅源 | 新增: Y 条 | 失败: Z 个源 | 跳过: K 个源
```

Skip empty sections. If there are only a few items, use short prose instead of a rigid report.

## Error Handling

- Partial feed fetch failure: log and continue; mention failed count.
- Skipped Weibo feeds due to consecutive failures are protective throttling, not "no content"; mention skipped count when
  present.
- All feed fetches fail: report failure explicitly.
- Subagent or inline analysis fails: include affected source/title and mark `分析失败`.
- Never say "no new content" when fetching failed.
