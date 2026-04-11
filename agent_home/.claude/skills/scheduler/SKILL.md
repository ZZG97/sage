---
name: scheduler
description: >
  Manage scheduled tasks: create reminders, recurring tasks, list and delete tasks.
  Use when: user says "提醒我", "remind me", "定时", "每天XX点", "XX分钟后", "XX点提醒",
  "查看定时任务", "删除提醒", "取消提醒", "scheduled tasks", "timer", "alarm",
  or any scheduling/reminder related request.
user_invocable: true
---

# Scheduler Skill

通过 Sage HTTP API 管理定时任务：创建提醒/周期任务、查看、删除。

**API Base:** `http://localhost:$(printenv PORT)/scheduler/tasks`（`PORT` 由 Sage 进程注入 env，自动区分 prod/dev）

**重要**：shell 里 `$PORT` 可能被 zsh profile 覆盖为空，必须用 `$(printenv PORT)` 取值。

## API 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/scheduler/tasks` | 列出活跃任务（`?all=true` 含已完成） |
| POST | `/scheduler/tasks` | 创建任务 |
| DELETE | `/scheduler/tasks/:id` | 删除/取消任务 |
| POST | `/scheduler/run/:name` | 手动触发内置任务 |

### 创建任务 POST body

```json
{
  "message": "要发送的消息内容",
  "pattern": "30 9 * * 1-5",   // cron pattern（周期任务，二选一）
  "triggerAt": 1712345678000    // epoch ms（一次性任务，二选一）
}
```

- `message`（必填）：触发时发送给用户的飞书消息
- `pattern`（周期）：标准 5 位 cron，时区 Asia/Shanghai
- `triggerAt`（一次性）：Unix 毫秒时间戳，必须是未来时间

## 工作流

### 1. 解析用户意图

用户输入自然语言，你需要判断：

| 意图 | 示例 |
|---|---|
| 一次性提醒 | "30分钟后提醒我开会"、"今天下午3点提醒我吃药"、"明天早上9点提醒" |
| 周期任务 | "每天早上8点提醒我喝水"、"每周五下午5点提醒写周报"、"工作日9:30提醒站会" |
| 查看任务 | "看看我有哪些定时任务"、"我的提醒列表" |
| 删除任务 | "取消那个喝水提醒"、"删掉明天的提醒" |

### 2. 创建一次性提醒

将用户描述的时间转换为 epoch ms。当前日期由系统注入（见 CLAUDE.md 的 currentDate）。

```bash
# 示例：30分钟后提醒
TRIGGER_AT=$(($(date +%s) * 1000 + 30 * 60 * 1000))
curl -s -X POST "http://localhost:$(printenv PORT)/scheduler/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"⏰ 提醒：该开会了\",\"triggerAt\":${TRIGGER_AT}}"
```

```bash
# 示例：今天下午3点（用 date 计算）
TRIGGER_AT=$(date -j -f "%Y-%m-%d %H:%M:%S" "2026-04-11 15:00:00" +%s)000
curl -s -X POST "http://localhost:$(printenv PORT)/scheduler/tasks" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"⏰ 提醒：该吃药了\",\"triggerAt\":${TRIGGER_AT}}"
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
curl -s -X POST "http://localhost:$(printenv PORT)/scheduler/tasks" \
  -H "Content-Type: application/json" \
  -d '{"message":"💧 该喝水了","pattern":"0 * * * *"}'
```

### 4. 查看任务

```bash
# 活跃任务
curl -s "http://localhost:$(printenv PORT)/scheduler/tasks" | python3 -m json.tool

# 全部（含已完成/已取消）
curl -s "http://localhost:$(printenv PORT)/scheduler/tasks?all=true" | python3 -m json.tool
```

展示格式示例：
```
📋 当前定时任务

| # | 类型 | 消息 | 时间 | 状态 |
|---|---|---|---|---|
| 1 | 一次性 | 提醒开会 | 04-11 15:00 | active |
| 2 | 周期 | 喝水提醒 | 每小时整点 | active |
```

- `pattern` 有值 → 周期任务，展示 cron 的中文解释
- `trigger_at` 有值 → 一次性，展示具体时间
- 用 `created_at` 的 epoch ms 转可读时间

### 5. 删除任务

先查看任务列表，找到 id，再删除：

```bash
curl -s -X DELETE "http://localhost:$(printenv PORT)/scheduler/tasks/{task_id}"
```

如果用户说"取消那个XX提醒"，先 GET 列表，匹配 message 内容找到 id，确认后删除。

## 注意事项

1. **时区**：所有时间基于 Asia/Shanghai（北京时间）
2. **消息内容**：添加合适的 emoji 前缀让飞书消息更醒目（⏰ 提醒、💧 习惯、📋 任务等）
3. **确认**：创建前向用户确认时间和消息内容，避免误设
4. **过期处理**：一次性任务的 triggerAt 必须是未来时间，否则 API 会报错
5. **cron 验证**：确保 cron pattern 合法，5 位格式（分 时 日 月 周）
6. **API 路由**：使用 `$PORT` 环境变量，自动适配 prod(3000)/dev(3001)
