# detail — 查看对话详情

用 session_id 从数据库拉取完整对话记录。当日记摘要信息不够时使用。

## 用法

```bash
# 用完整 session_id 查询
bun agent_home/.claude/skills/memory/scripts/query-history.ts --session <session_id>

# 用前缀模糊匹配（日记里记录的 sid:xxx 前 8 位）
bun agent_home/.claude/skills/memory/scripts/query-history.ts --session <prefix>
```

输出为该 session 的完整事件列表（用户消息 + agent 回复），按时间排序。

## 典型场景

1. 用户看日记发现某条摘要，想了解完整对话
2. 日记里记录了 `sid:abc12345`，用 `--session abc12345` 拉取详情
3. 如果前缀匹配到多个 session，列出供用户选择
