---
name: memory
description: >
  Unified memory management: journal generation, session detail lookup, memory update, and memory tidying.
  Use when the user says "写日记", "总结今天", "daily journal", "周记", "weekly summary",
  "记住", "remember", "整理记忆", "tidy memory", "查看对话", "对话详情",
  or any memory-related operation.
user_invocable: true
---

# Memory Skill

统一的记忆管理入口。根据用户意图判断子命令，然后读取对应文件获取详细指引。

| 意图 | 子命令 | 详细指引 |
|---|---|---|
| 写日记、总结今天、周记 | journal | 读取 `agent_home/.claude/skills/memory/commands/journal.md` |
| 查看某次对话详情 | detail | 读取 `agent_home/.claude/skills/memory/commands/detail.md` |
| 记住某个信息 | update | 读取 `agent_home/.claude/skills/memory/commands/update.md` |
| 整理记忆 | tidy | 读取 `agent_home/.claude/skills/memory/commands/tidy.md` |

**操作步骤：** 判断意图 → 读取对应子命令文件 → 按指引执行。
