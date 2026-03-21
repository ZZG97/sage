# update — 写入/更新记忆

用户说"记住 X"或需要持久化某个信息时使用。

## 流程

1. 读取 `agent_home/memory/MEMORY.md` 索引
2. 判断是否有已存在的相关文件可以**合并追加**
3. 有 → 追加到该文件；无 → 新建文件
4. 同步更新 MEMORY.md 索引
5. 检查索引条目是否超过 **10 条**上限，超了提醒用户需要 tidy

## 记忆文件格式

```markdown
---
name: 简短名称
description: 包含触发关键词的描述，面向召回而写
type: project | reference | user
---

内容。简洁、信息密度高。
```

## 原则

- 一条记忆只存一个地方，不与 SOUL.md / USER.md 重复
- description 要包含**触发词**——什么场景下需要这条记忆
- 同主题合并到一个文件，不要每条记忆一个文件
