# Sage AI Assistant

> ⚠️ **Sage 由 pm2 管理运行**（`sage` / `sage-dev`）。README 中的 `bun run dev` / `bun run start` 仅适用于手动本地开发调试。**Agent 禁止使用这些命令启动进程**，否则会导致端口冲突。所有进程操作只能通过 pm2。

一个个人 AI 助手，通过飞书交互，支持多 Agent 后端（Claude Code / OpenCode），可执行代码、操作浏览器、完成各种任务。

## 功能特性

- **飞书集成** - 通过飞书机器人接收和发送消息
- **多 Agent 后端** - 可插拔的 Agent 层，支持 Claude Code、OpenCode，可扩展
- **上下文隔离** - 基于飞书话题的会话隔离，互不干扰
- **Web服务** - 提供 RESTful API 接口（健康检查、状态查看、会话清理）
- **优雅关闭** - 支持优雅的服务启停

## 架构

```
飞书用户 ──WebSocket──▶ FeishuService ──▶ SageCore ──▶ AgentProvider ──▶ AI 后端
                                            │
                                     ┌──────┴──────┐
                                     │ 可插拔接口   │
                                     ├─────────────┤
                                     │ Claude Code │  ← CLI subprocess
                                     │ OpenCode    │  ← HTTP SDK
                                     │ (自定义)     │  ← 实现 AgentProvider 接口
                                     └─────────────┘
```

## 项目结构

```
src/
├── agent/               # Agent 抽象层
│   ├── types.ts         # AgentProvider 接口定义
│   ├── claude-code-provider.ts  # Claude Code 实现
│   ├── opencode-provider.ts     # OpenCode 实现
│   └── index.ts         # 工厂函数
├── config/              # 配置管理
│   └── index.ts
├── services/            # 服务层
│   ├── core.ts          # SageCore 核心逻辑
│   ├── feishu.ts        # 飞书服务
│   ├── web.ts           # Web 服务
│   └── index.ts
├── types/               # 类型定义
│   └── index.ts
├── utils/               # 工具函数
│   └── index.ts
└── index.ts             # 应用入口
```

## 快速开始

### 1. 安装环境

**安装 Bun**（macOS / Linux）：
```bash
curl -fsSL https://bun.sh/install | bash
```

安装完成后重新加载 shell：
```bash
exec $SHELL
```

验证安装：
```bash
bun --version  # 需要 1.0+
```

**其他依赖**：
- 飞书开发者账号和应用
- Agent 后端（二选一）：
  - **Claude Code**：`npm install -g @anthropic-ai/claude-code`，需要 Anthropic API key
  - **OpenCode**：`curl -fsSL https://opencode.ai/install | bash`

### 2. 安装项目依赖

```bash
cd sage
bun install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# === 飞书配置（必填）===
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here

# === Agent 后端选择 ===
# 'opencode'、'claude-code' 或 'codex'
AGENT_PROVIDER=claude-code

# --- OpenCode 配置（AGENT_PROVIDER=opencode 时）---
OPENCODE_BASE_URL=http://127.0.0.1:4111

# --- Claude Code 配置（AGENT_PROVIDER=claude-code 时）---
CLAUDE_CODE_WORK_DIR=/path/to/your/workspace
CLAUDE_CODE_MAX_TURNS=25
CLAUDE_CODE_MODEL=sonnet
# CLAUDE_CODE_ALLOWED_TOOLS=Read,Bash,Edit,Grep,Glob,WebSearch,WebFetch

# --- Codex 配置（AGENT_PROVIDER=codex 时）---
CODEX_WORK_DIR=/path/to/your/workspace
CODEX_MODEL=gpt-5.3-codex
CODEX_REASONING_EFFORT=medium
CODEX_SANDBOX_MODE=danger-full-access

# === 服务器配置 ===
PORT=3000
HOST=0.0.0.0
```

### 4. 运行

```bash
# 开发模式
bun run dev

# 生产模式
bun run start
```

## API接口

### 健康检查
```
GET /health
```

### 服务状态
```
GET /status
```

### 清理过期会话
```
POST /cleanup
```

### 测试消息
```
POST /test/message
Content-Type: application/json

{
  "message": "测试消息"
}
```

## 飞书配置

1. 在[飞书开放平台](https://open.feishu.cn/)创建应用
2. 获取应用凭证（App ID和App Secret）
3. 配置事件订阅（可选，主要使用WebSocket）
4. 授予必要的权限：
   - 获取用户基本信息
   - 发送消息
   - 读取消息

## 开发指南

### 添加新的 Agent Provider

实现 `AgentProvider` 接口（`src/agent/types.ts`），然后在 `src/agent/index.ts` 的工厂函数中注册即可：

```typescript
// src/agent/my-provider.ts
import { AgentProvider, AgentSession, AgentResponse } from './types';

export class MyProvider implements AgentProvider {
  readonly name = 'my-provider';
  // ... 实现接口方法
}
```

### 错误处理

使用 `AppError` 类来处理应用错误：

```typescript
throw new AppError('错误消息', 'ERROR_CODE', 400);
```

### 日志记录

使用 `Logger` 类来记录日志：

```typescript
const logger = new Logger('ServiceName');
logger.info('信息日志');
logger.error('错误日志');
```

### 测试原则

默认测试命令：

```bash
bun run test
```

单测优先覆盖纯函数、规则判断和本地渲染逻辑，例如 markdown/card 处理、RSS 刷新策略、workflow payload 校验、日志脱敏等。这类测试应使用 `bun:test`，放在被测代码旁边的 `*.test.ts` 文件中，避免依赖飞书、真实 AI provider、生产数据库或外部网络。

涉及 SQLite 的 service 测试应使用临时数据库或内存数据库，不得读写 `data/*.db` 生产/开发库。涉及 Feishu、Claude/Codex/OpenCode provider 的行为测试应优先 mock 边界接口，只验证 Sage 自己的流转、拆卡、fallback、abort 等逻辑。

会真实调用飞书、AI provider、浏览器或本机环境的脚本属于手工/端到端探针，放在 `scripts/manual/`，不要纳入默认 `bun run test`。

## 部署

### 使用Bun运行

```bash
bun run start
```

### 构建

```bash
bun run build
```

### Docker部署（可选）

可以创建Dockerfile来容器化部署：

```dockerfile
FROM oven/bun:latest

WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install

COPY . .
RUN bun run build

EXPOSE 3000
CMD ["bun", "run", "start"]
```

## 监控和维护

- 定期检查 `/health` 接口确保服务健康
- 使用 `/status` 查看服务状态
- 定期调用 `/cleanup` 清理过期会话
