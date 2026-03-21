# journal — 生成日记/周记

## 查询数据

```bash
# 查今天的对话
bun agent_home/.claude/skills/memory/scripts/query-history.ts --date today

# 查指定日期
bun agent_home/.claude/skills/memory/scripts/query-history.ts --date 2026-03-21

# 查最近 N 天
bun agent_home/.claude/skills/memory/scripts/query-history.ts --recent 7
```

输出为 JSON 数组，每个元素包含 session 信息和 events 列表。

## 日记格式

```markdown
# 2026-03-21
- 09:15 `sid:abc12345` [主题标签] 简要内容
- 14:30 `sid:def45678` [主题标签] 简要内容
```

## 日记规则

- 每个有意义的会话一行，前面带 `sid:xxx`（session id 前 8 位）方便后续 detail 查询
- 跳过纯问候、测试消息、无实质内容的会话
- 只记录有价值的信息：做了什么、决策、问题、学到的东西
- 主题标签简短，如 [Sage开发]、[问题排查]、[闲聊]
- 写入 `agent_home/memory/journals/YYYY-MM-DD.md`

## 周记整合

1. 读取 `agent_home/memory/journals/` 下本周的日记文件
2. 整合为 `agent_home/memory/journals/YYYY_WXX.md`

```markdown
# 2026 第12周 (03.16 ~ 03.22)
## 关键进展
- ...
## 决策记录
- ...
## 待办
- ...
```

**周记规则：**
- 去掉琐碎细节，只保留有长期参考价值的内容
- 整合后将对应日记文件移到 `agent_home/memory/journals/archive/`（保留 session_id 线索，需要时可查）
- 更新 `agent_home/memory/MEMORY.md` 索引
