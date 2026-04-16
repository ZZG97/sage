---
name: rss-reader
description: >
  Read and summarize RSS feeds for the user. Use when: user says "读一下RSS", "帮我汇总今天的订阅",
  "run rss reader", "RSS digest", "今日资讯", "信息汇总", or asks to read/analyze RSS feeds.
  Trigger when user wants to digest RSS content rather than just fetch it.
  This skill handles the full pipeline: fetch → dedup → split → subagent analysis → summarize → report.
  Do NOT trigger for simple "fetch this RSS URL" requests — only for full digest/summarize workflows.
user_invocable: true
---

# RSS Reader Skill

Read RSS feeds, deduplicate against history, split into chunks, analyze, and report summaries to user.

## Workflow

### Step 1: Fetch items

```bash
CHUNKS=$(./.claude/skills/rss-reader/scripts/fetch_items.sh)
```

The script:
- Reads feed URLs from `~/.rsshub/feeds.txt` or the skill's `feeds.txt` (one URL per line, `#` for comments)
- Fetches all RSS feeds
- Deduplicates against the skill's `data/pushed.csv` (uses `guid` as primary key)
- Writes chunk files (10 items per chunk) to the skill's `data/chunks/`
- Outputs chunk file paths to stdout, one per line

**Output format:** absolute paths, one per line  
Example: `/abs/path/.../chunk_001.jsonl`

**Exit codes:**
- `0` = success (may output nothing if no new items)
- `1` = no feeds file found
- `2` = all feed fetches failed
- `3` = another RSS run is in progress

### Step 2: Read chunk files and launch subagents

Use this decision tree to reduce model load:
1. No chunk files:
   Output `今日没有新内容`, stop.
2. 1-2 chunk files (<=20 items):
   Analyze inline in the current agent (do not spawn subagents).
3. 3+ chunk files:
   Spawn subagents, but cap at 3 subagents total.
   If chunk count > 3, group chunk contents into 3 merged batches, then analyze.

Always read JSONL lines as-is; one JSON object per line.

**Subagent prompt template:**
```
Analyze the following RSS items and produce a concise summary suitable for the user.

For each item, extract:
- What is this about (1-2 sentences)
- Why it might matter to the user

Then provide:
- A brief overall summary (3-5 sentences)
- Top 3 most interesting items with their links (format: [title](url))

RSS items:
{BATCH_CONTENT}
```

### Step 3: Aggregate and report

Merge all analysis results (inline + subagent), output:

```
📰 今日资讯 (N条新内容)

[Subagent summaries]

---
来源: X 个订阅源 | 新增: Y 条
```

## Error Handling

- Partial feed fetch failure → log error, continue with other feeds
- All feed fetches fail (`exit 2`) → report fetch failure explicitly, do not say "no new content"
- No new items → output "今日没有新内容"
- Subagent fails → include raw item data with "分析失败" note
