---
name: summarize-journal
description: >
  Generate daily journals from conversation history and consolidate weekly summaries.
  Use when the user says "写日记", "总结今天", "daily journal", "summarize today",
  "今天做了什么", "这周总结", "weekly summary", "周记",
  or asks about what happened today/this week in conversations.
user_invocable: true
---

# Summarize Journal

根据对话历史生成日记或周记。

## 查询数据

使用内置脚本查询对话历史（不需要 Sage 服务运行，直接读 SQLite）：

```bash
# 查今天的对话
bun agent_home/.claude/skills/summarize-journal/scripts/query-history.ts --date today

# 查指定日期
bun agent_home/.claude/skills/summarize-journal/scripts/query-history.ts --date 2026-03-21

# 查最近 N 天
bun agent_home/.claude/skills/summarize-journal/scripts/query-history.ts --recent 7
```

输出为 JSON 数组，每个元素包含 session 信息和 events 列表。

## 日记生成

1. 运行脚本获取当天数据
2. 分析每个 session 的对话内容
3. 写入 `agent_home/memory/journals/YYYY-MM-DD.md`

**格式：**
```markdown
# 2026-03-21
- 09:15 [主题标签] 简要内容
- 14:30 [主题标签] 简要内容
```

**规则：**
- 每个有意义的会话一行
- 跳过纯问候、测试消息、无实质内容的会话
- 只记录有价值的信息：做了什么、决策、问题、学到的东西
- 主题标签简短，如 [Sage开发]、[问题排查]、[闲聊]

## 周记整合

1. 读取 `agent_home/memory/journals/` 下的日记文件
2. 整合为周记

**格式：**
```markdown
# 2026 第12周 (03.16 ~ 03.22)
## 关键进展
- ...
## 决策记录
- ...
## 待办
- ...
```

**规则：**
- 去掉琐碎细节，只保留有长期参考价值的内容
- 整合后删除对应的日记文件
- 更新 `agent_home/memory/MEMORY.md` 索引，在 `## Journals` 下添加周记链接
