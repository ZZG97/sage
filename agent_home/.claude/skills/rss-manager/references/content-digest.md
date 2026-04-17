# Content Digest Workflow

Use this file when reading, organizing, summarizing, or reporting RSS content.

## Fetch

Run:

```bash
CHUNKS=$(./.claude/skills/rss-manager/scripts/fetch_items.sh)
```

The script:

- Reads feed URLs from `~/.rsshub/feeds.txt` or skill-local `feeds.txt`.
- Fetches all RSS feeds.
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

Prefer signal over coverage. Group similar items instead of repeating summaries.

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

来源: X 个订阅源 | 新增: Y 条 | 失败: Z 个源
```

Skip empty sections. If there are only a few items, use short prose instead of a rigid report.

## Error Handling

- Partial feed fetch failure: log and continue; mention failed count.
- All feed fetches fail: report failure explicitly.
- Subagent or inline analysis fails: include affected source/title and mark `分析失败`.
- Never say "no new content" when fetching failed.
