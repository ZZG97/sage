# Sage 项目开发计划

## 项目概述

目标：构建一个个人内部 AI 助手，通过飞书交互，能调用内部系统、记住上下文、定时主动触发任务，并能随着使用自我进化。

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | Bun | 原生 TypeScript，性能好 |
| Web 框架 | Hono | 轻量、类型安全 |
| 存储 | bun:sqlite | 内置零依赖，消息流水存储 |
| 文件存储 | Markdown | 长期/中期记忆，可读可编辑 |

## 核心特性

1. **飞书接入** - 通过飞书机器人接收和发送消息
2. **Agent 能力** - 基于 OpenCode SDK 实现智能对话
3. **三级记忆** - 短期(Thread上下文) + 中期(摘要) + 长期(用户记忆)
4. **Skill 系统** - 可扩展的技能框架
5. **定时任务** - 主动触发提醒和任务

---

## 已完成

### 基础架构

- 模块化分层设计（services / types / utils / config）
- 完整 TypeScript 类型定义
- 环境变量配置与验证
- 自定义错误类（AppError）+ 全局错误处理
- 结构化日志系统（多级别、上下文标签）
- 异步重试机制

### 飞书服务 (FeishuService)

- WebSocket 长连接，实时接收消息事件
- 消息内容解析（文本消息）
- 消息去重机制（基于事件 ID）
- 发送者身份提取（open_id）
- Thread 上下文提取（thread_id）
- 统一以话题形式回复（reply_in_thread）
- message_id → thread_id 映射记录

### OpenCode 服务 (OpenCodeService)

- AI 会话管理（创建、获取、删除）
- 智能对话（发送消息并接收回复）
- 响应解析（多格式兼容）
- 会话过期清理机制
- 健康检查

### 核心逻辑 (SageCore)

- Thread 隔离的会话管理（每个 thread 独立 OpenCode 会话）
- 用户身份识别（基于 open_id）
- MessageContext 完整上下文传递
- 斜杠命令系统：/thread_id、/clear、/help
- 定时清理过期 thread 会话

### Web 服务 (WebServer)

- RESTful API：/health、/status、/cleanup、/test/message
- CORS 跨域支持
- Hono + Bun.serve()

### 项目结构

```
src/
├── config/          # 配置管理
├── services/        # 服务层
│   ├── core.ts      # 核心应用逻辑（Thread隔离 + 斜杠命令）
│   ├── feishu.ts    # 飞书服务（WebSocket + 消息上下文提取）
│   ├── opencode.ts  # OpenCode服务
│   └── web.ts       # Web服务
├── types/           # 类型定义（含 MessageContext）
├── utils/           # 工具函数
└── index.ts         # 应用入口
```

---

## 当前需求

### 第一步：消息流水存储（SQLite）

用 `bun:sqlite` 持久化每条对话记录，为中期记忆和 skill 查询提供数据基础。

```sql
messages:
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  thread_id     TEXT        -- omt_xxx 或 msg:xxx
  open_id       TEXT        -- 发送者
  role          TEXT        -- user / assistant
  content       TEXT        -- 消息内容
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

- 在 SageCore 中，每次用户发消息和 AI 回复后，写入 messages 表
- 数据库文件存放在 `data/sage.db`

### 第二步：Skill 系统框架

可扩展的技能框架，后续记忆功能都建立在 skill 之上。

- 定义 Skill 接口（名称、描述、触发方式、执行逻辑）
- Skill 注册和调度机制
- 斜杠命令作为 skill 的触发方式之一
- 现有的 /thread_id、/clear、/help 迁移为内置 skill

### 第三步：长期记忆（memory.md）— 基于 Skill

通过 skill 实现用户记忆管理，文件存储，可读可编辑。

```
data/memories/{open_id}/memory.md
```

文件内容按主题分块（Markdown），AI 负责组织和更新：

```markdown
## 偏好
- 偏好简洁回复
- 开发用 Bun + TypeScript

## 工作
- 周三固定有例会
- 负责 Sage 项目
```

**Skill：**
- `remember` — `/remember <内容>`，AI 读取现有内容 → 整体重组织 → 覆盖写入（智能去重和更新）
- `forget` — `/forget <关键词>`，AI 从文件中移除相关内容
- `memories` — `/memories`，显示当前所有记忆
- AI 也可在对话中主动建议"要我记住吗？"，用户确认后触发 remember skill

**更新原则：** memory.md 的每次修改都要经过用户意愿，不能自动写入。

**使用方式：** 每次对话前读取 memory.md，注入给 AI 作为上下文前缀。

### 第四步：中期记忆（summaries）— 基于 Skill

通过 skill 实现 Thread 摘要的生成和管理。

**文件结构：**

```
data/memories/{open_id}/
├── recent_summaries.md    -- 最近50条摘要（每次对话必定注入）
└── summaries/
    ├── 2026-03.md         -- 历史归档
    ├── 2026-04.md
    └── ...
```

**Skill：**
- `summarize` — 生成/更新当前 thread 的摘要，写入 recent_summaries.md
  - 自动触发：每轮对话结束后异步执行
  - 手动触发：`/summary`
- `search_history` — 从 SQLite 按 thread_id 查询完整对话明细
  - AI 从 recent_summaries.md 看到索引，判断需要详情时自动调用

**滚动机制：**
- 新摘要写入 recent_summaries.md 顶部
- 超过 50 条时，最旧的移入对应月份的归档文件（summaries/YYYY-MM.md）
- 每次对话只注入 recent_summaries.md，历史归档通过 skill 按需查

**摘要格式：**

```markdown
## 2026-03-10 omt_abc123
讨论了 Redis 缓存方案，决定用 Bun.redis，TTL 设为 1 小时。

## 2026-03-11 omt_def456
排查了飞书 WebSocket 断连问题，原因是心跳超时，已修复。
```

---

## 三级记忆体系

```
短期：OpenCode 会话内存（Thread 内实时上下文）
中期：recent_summaries.md（最近 50 条 Thread 摘要，每次注入）
长期：memory.md（用户偏好和事实，每次注入）
流水：SQLite messages 表（原始对话记录，通过 skill 按需查询）
归档：summaries/YYYY-MM.md（历史摘要，通过 skill 按需查询）
```

核心原则：**文件管"知识"，数据库管"数据"。**

---

## 远期规划

1. **更多 Skill** — 查内部系统、调外部 API、执行脚本
2. **定时任务** — AI 主动推送提醒、监控异常、定期汇报
3. **多模态** — 支持图片、文件消息，回复用飞书卡片消息
4. **工作流集成** — 接入内部系统和工具链
5. **多平台** — 扩展到企业微信、钉钉等
