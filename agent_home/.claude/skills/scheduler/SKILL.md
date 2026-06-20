---
name: scheduler
description: >
  Manage scheduled tasks: create reminders, recurring tasks, update tasks, list and delete tasks.
  Use when: user says "提醒我", "remind me", "定时", "每天XX点", "XX分钟后", "XX点提醒",
  "查看定时任务", "删除提醒", "取消提醒", "scheduled tasks", "timer", "alarm",
  or any scheduling/reminder related request.
user_invocable: true
---

# Scheduler Skill

通过 Sage HTTP API 管理定时任务：创建提醒/周期任务、更新、查看、删除。

**API Helper:** `bun ~/workspace/sage/agent_home/scripts/sage-api.ts METHOD PATH [--json JSON]`

**重要**：不要裸 `curl` Sage API。统一使用 `sage-api.ts`，它会读取 `PORT` / `SAGE_API_BASE_URL` 并自动带 `SAGE_INTERNAL_HTTP_TOKEN` 或 `SAGE_HTTP_TOKEN`。

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/scheduler/tasks` | 列出活跃任务（`?all=true` 含已完成） |
| POST | `/scheduler/tasks` | 创建任务 |
| PATCH | `/scheduler/tasks/:id` | 更新 active 动态任务，并刷新运行中的 scheduler 注册项 |
| DELETE | `/scheduler/tasks/:id` | 删除/取消任务 |
| POST | `/scheduler/run/:name` | 手动触发内置任务 |

### 创建任务 POST body

```json
{
  "kind": "message",            // 'message'(默认,纯文本提醒) | 'agent'(触发 agent 对话) | 'workflow'(线性 step 工作流)
  "message": "要发送的消息、prompt，或 workflow 的人类可读摘要",
  "title": "任务标题",            // agent/workflow 可选
  "reuseConversationId": "conv_xxx", // agent/workflow 可选；到点后复用该 conversation/session 并回到原飞书话题
  "workflow": {                  // kind='workflow' 时必填
    "version": 1,
    "steps": [
      { "id": "prep", "kind": "shell", "command": "echo ready", "cwd": "~/workspace/sage/agent_home", "timeoutSec": 30 },
      { "id": "digest", "kind": "agent", "title": "示例", "prompt": "基于 workflow 上下文继续处理，不要重跑 shell" }
    ]
  },
  "pattern": "30 9 * * 1-5",   // cron pattern（周期任务，二选一）
  "triggerAt": 1712345678000    // epoch ms（一次性任务，二选一）
}
```

- `kind`（可选，默认 `message`）：
  - `message` — 到点直接发一条飞书纯文本。便宜、快，适合"提醒我吃药""30分钟后叫我起床"这种静态提醒。
  - `agent` — 到点触发一次完整的 agent 对话，结果以**流式卡片**形式发送（和用户主动对话体验一致，能看到思考/工具调用过程）。适合"每天早上帮我汇总 GitHub notifications""每周五生成工作总结"这种需要实时计算或联网的任务。默认每次执行创建独立 session；如 body 带 `reuseConversationId`，则复用对应 conversation/session 并把卡片发回原话题。
  - `workflow` — 一个调度任务内顺序执行多个 step，目前只支持线性 `shell` / `agent` steps。适合"先拉数据，再让 agent 总结"这类任务；比如 RSS 先跑抓取脚本，再让 agent 基于产物输出摘要。
- `message`（非 workflow 时必填）：kind=message 时为文本内容；kind=agent 时作为喂给 agent 的 prompt（请求里也可用 `prompt` 字段，API 会归一化写入 `message`；响应不会保留单独 `prompt` 字段）；kind=workflow 时可作为任务摘要，不填则后端会根据 steps 自动生成。
- `workflow`：仅 kind=workflow 时使用。`steps` 目前只支持：
  - `shell` step：`command` 必填，可选 `cwd` / `timeoutSec`
  - `agent` step：`prompt` 必填，可选 `title`
- `reuseConversationId`（agent/workflow 可选）：复用某个 Sage 内部 conversation。当前 Codex shell 环境有 `SAGE_CONVERSATION_ID` 时，用户说"稍后继续这个话题/提醒我继续处理"这类语义，应传 `reuseConversationId: "$SAGE_CONVERSATION_ID"`；到点后 Sage 会恢复该 conversation 的 agent session，并把流式卡片回复到原飞书 thread。普通日记、日报、RSS 摘要这类独立周期任务不要传。
- **注意**：当前没有独立的顶层 `shell` kind。只跑 shell 的定时任务，也要用单 step `workflow` 表达。
- `pattern`（周期）：标准 5 位 cron，时区 Asia/Shanghai
- `triggerAt`（一次性）：Unix 毫秒时间戳，必须是未来时间

### 复用上下文决策

只在任务是"当前对话的延迟后续动作"时使用 `reuseConversationId`。典型触发词：继续、回到这个话题、刚才那个、这件事、这个 PR、这段代码、我们上面说的、稍后再处理。复用后会同时复用 Sage conversation、agent session、Codex thread，并把结果回复回原飞书 thread。

复用上下文时，任务描述可以保持简短，不要把当前对话的大段背景重新塞进 prompt；agent 到点后能从原 session/history 中拿到上下文。prompt 只需要写清楚"到点要继续做什么"，例如："继续这个话题，提醒我回到刚才的问题，并基于上下文继续处理。"

默认不要复用上下文的场景：独立提醒、日记/周报/RSS 摘要、天气/健康/服务巡检、GitHub notifications 汇总、长期周期任务。周期任务默认新开，除非用户明确要求"每次都在这个话题里跟踪/继续"。

## 工作流

### 1. 解析用户意图

用户输入自然语言，你需要判断两件事：①时间维度（一次性/周期） ②是否需要 agent 能力（kind）：

| 意图 | kind | 示例 |
|---|---|---|
| 一次性提醒 | message | "30分钟后提醒我开会"、"今天下午3点提醒我吃药"、"明天早上9点提醒" |
| 周期提醒 | message | "每天早上8点提醒我喝水"、"每周五下午5点提醒写周报"、"工作日9:30提醒站会" |
| 一次性 agent 任务 | agent | "1小时后帮我查一下北京天气并总结"、"今晚10点帮我把今天的 git 提交汇总一下" |
| 周期 agent 任务 | agent | "每天早上帮我汇总 GitHub notifications"、"每周五生成本周工作总结"、"每天9点帮我看看 sage-dev 有没有异常日志" |
| 先准备再处理 | workflow | "每2小时先抓 RSS，再让 agent 汇总"、"每天9点先跑脚本收集日志，再分析异常" |
| 查看任务 | — | "看看我有哪些定时任务"、"我的提醒列表" |
| 删除任务 | — | "取消那个喝水提醒"、"删掉明天的提醒" |

**kind 判断原则：** 用户描述是"让系统到点发一条静态文字"就是 `message`；用户描述需要到点**做事/查信息/生成内容**但不强调前置准备，就是 `agent`；用户明确是"先跑脚本/拉数据，再总结/分析/发结果"，或者为了稳定性必须把准备阶段从 agent 决策里拿出来，就是 `workflow`。拿不准时优先问用户。

### 2. 创建一次性提醒

将用户描述的时间转换为 epoch ms。当前日期由系统注入（见 CLAUDE.md 的 currentDate）。

```bash
# 示例：30分钟后提醒（纯文本）
TRIGGER_AT=$(($(date +%s) * 1000 + 30 * 60 * 1000))
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json "{\"kind\":\"message\",\"message\":\"⏰ 提醒：该开会了\",\"triggerAt\":${TRIGGER_AT}}"
```

```bash
# 示例：1小时后让 agent 汇总天气（agent 类任务）
TRIGGER_AT=$(($(date +%s) * 1000 + 60 * 60 * 1000))
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json "{\"kind\":\"agent\",\"prompt\":\"帮我查一下北京天气并总结发给我\",\"triggerAt\":${TRIGGER_AT}}"
```

```bash
# 示例：30分钟后回到当前话题继续处理（复用当前 conversation/session）
TRIGGER_AT=$(($(date +%s) * 1000 + 30 * 60 * 1000))
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json "{\"kind\":\"agent\",\"prompt\":\"继续这个话题：提醒用户回到刚才的问题，并基于当前上下文继续处理。\",\"reuseConversationId\":\"$(printenv SAGE_CONVERSATION_ID)\",\"triggerAt\":${TRIGGER_AT}}"
```

```bash
# 示例：今天下午3点（用 date 计算）
TRIGGER_AT=$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-04-11 15:00:00" +%s)000
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json "{\"message\":\"⏰ 提醒：该吃药了\",\"triggerAt\":${TRIGGER_AT}}"
```

**注意**：macOS 用 `date -j -f` 格式，计算 epoch 秒后拼 `000` 变毫秒。

### 3. 创建周期任务

将用户描述转换为 cron pattern。常用 pattern：

| 描述 | Cron |
|---|---|
| 每天早上8点 | `0 8 * * *` |
| 工作日9:30 | `30 9 * * 1-5` |
| 每周五17:00 | `0 17 * * 5` |
| 每小时 | `0 * * * *` |
| 每天中午12点 | `0 12 * * *` |

```bash
# 纯文本周期提醒
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json '{"kind":"message","message":"💧 该喝水了","pattern":"0 * * * *"}'

# 周期 agent 任务
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json '{"kind":"agent","prompt":"汇总今天的 GitHub notifications 并发给我","pattern":"0 9 * * *"}'

# 周期 workflow：先 shell，再 agent
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks \
  --json '{
    "kind":"workflow",
    "title":"RSS 定时摘要",
    "message":"先抓 RSS，再让 agent 汇总",
    "pattern":"0 */2 * * *",
    "workflow":{
      "version":1,
      "steps":[
        {
          "id":"fetch",
          "kind":"shell",
          "command":"./.claude/skills/rss-manager/scripts/fetch_items.sh",
          "cwd":"~/workspace/sage/agent_home",
          "timeoutSec":2400
        },
        {
          "id":"digest",
          "kind":"agent",
          "title":"RSS 定时摘要",
          "prompt":"不要重跑 fetch；直接基于 workflow 上下文中的 shell 产物做摘要。"
        }
      ]
    }
  }'
```

### 4. 查看任务

```bash
# 活跃任务
bun ~/workspace/sage/agent_home/scripts/sage-api.ts GET /scheduler/tasks

# 全部（含已完成/已取消）
bun ~/workspace/sage/agent_home/scripts/sage-api.ts GET '/scheduler/tasks?all=true'
```

展示格式示例：
```
📋 当前定时任务

| # | 触发 | kind | 内容 | 时间 | 状态 |
|---|---|---|---|---|---|
| 1 | 一次性 | message | 提醒开会 | 04-11 15:00 | active |
| 2 | 周期 | message | 喝水提醒 | 每小时整点 | active |
| 3 | 周期 | agent | 汇总 GitHub notifications | 每天 09:00 | active |
| 4 | 周期 | workflow | 先抓 RSS，再让 agent 汇总 | 每2小时 | active |
```

- `pattern` 有值 → 周期任务，展示 cron 的中文解释
- `trigger_at` 有值 → 一次性，展示具体时间
- `kind=agent` 时"内容"展示的是 prompt；卡片结果用户会看到完整 agent 输出
- `kind=workflow` 时"内容"展示的是摘要 message；如需细看，可查看 `payload.workflow.steps`
- 用 `created_at` 的 epoch ms 转可读时间

### 5. 更新任务

先查看任务列表，找到 id，再用完整的新配置 PATCH。PATCH 会原地更新 active 任务，并同步刷新运行中的 scheduler 注册项；不要为了改文案/cron 先 DELETE 再 POST，除非 PATCH 返回不支持或任务已不是 active。

```bash
# 更新纯文本提醒内容和 cron
bun ~/workspace/sage/agent_home/scripts/sage-api.ts PATCH /scheduler/tasks/{task_id} \
  --json '{"kind":"message","message":"⏰ 提醒：更新后的内容","pattern":"30 9 * * 1-5"}'
```

```bash
# 更新 workflow 的 agent prompt
bun ~/workspace/sage/agent_home/scripts/sage-api.ts PATCH /scheduler/tasks/{task_id} \
  --json '{
    "kind":"workflow",
    "title":"RSS 定时摘要",
    "message":"先抓 RSS，再让 agent 汇总",
    "pattern":"0 */2 * * *",
    "workflow":{
      "version":1,
      "steps":[
        {
          "id":"fetch",
          "kind":"shell",
          "command":"./.claude/skills/rss-manager/scripts/fetch_items.sh",
          "cwd":"~/workspace/sage/agent_home",
          "timeoutSec":2400
        },
        {
          "id":"digest",
          "kind":"agent",
          "title":"RSS 定时摘要",
          "prompt":"这是由 Sage scheduler 自动触发的 RSS workflow。使用 rss-manager skill 总结内容；不要重新运行 RSS 抓取脚本；直接基于 workflow 上下文里 fetch step 的 stdout/stderr 文件、chunk 路径和抓取统计做分析；最后报告来源数、新增数、失败数、跳过数和需要调整的订阅建议。若 fetch step 没有产出 chunk 文件且抓取成功，输出“今日没有新内容”；若抓取失败，要明确报失败，不要误报无新内容。"
        }
      ]
    }
  }'
```

- PATCH body 和 POST body 结构相同，必须带完整 `kind`、内容、`pattern` 或 `triggerAt`。
- 只能更新 `active` 动态任务；`completed/cancelled` 任务需要新建。
- 更新 one-shot 任务时，新的 `triggerAt` 仍必须是未来时间。

### 6. 删除任务

先查看任务列表，找到 id，再删除：

```bash
bun ~/workspace/sage/agent_home/scripts/sage-api.ts DELETE /scheduler/tasks/{task_id}
```

如果用户说"取消那个XX提醒"，先 GET 列表，匹配 message 内容找到 id，确认后删除。

## 注意事项

1. **时区**：所有时间基于 Asia/Shanghai（北京时间）
2. **消息内容**：添加合适的 emoji 前缀让飞书消息更醒目（⏰ 提醒、💧 习惯、📋 任务等）
3. **确认**：创建前向用户确认时间和消息内容，避免误设
4. **过期处理**：一次性任务的 triggerAt 必须是未来时间，否则 API 会报错
5. **cron 验证**：确保 cron pattern 合法，5 位格式（分 时 日 月 周）
6. **API 路由**：统一使用 `sage-api.ts`，自动适配 prod(3000)/dev(3001) 并携带 Sage HTTP token
