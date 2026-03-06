# Sage AI Assistant

一个个人内部AI助手，通过飞书交互，集成OpenCode AI能力，支持智能对话和任务处理。

## 功能特性

- **飞书集成** - 通过飞书机器人接收和发送消息
- **AI对话** - 基于OpenCode SDK实现智能对话
- **上下文记忆** - 支持会话管理和上下文保持
- **Web服务** - 提供RESTful API接口
- **健康监控** - 服务状态监控和健康管理
- **优雅关闭** - 支持优雅的服务启停

## 技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 运行时 | Bun | 原生 TypeScript，性能好 |
| Web 框架 | Hono | 轻量、类型安全 |
| 飞书SDK | @larksuiteoapi/node-sdk | 官方SDK |
| AI能力 | @opencode-ai/sdk | OpenCode AI服务 |

## 项目结构

```
src/
├── config/          # 配置管理
│   └── index.ts
├── services/        # 服务层
│   ├── core.ts      # 核心应用逻辑
│   ├── feishu.ts    # 飞书服务
│   ├── opencode.ts  # OpenCode服务
│   ├── web.ts       # Web服务
│   └── index.ts     # 服务导出
├── types/           # 类型定义
│   └── index.ts
├── utils/           # 工具函数
│   └── index.ts
└── index.ts         # 应用入口
```

## 快速开始

### 环境要求

- Bun 1.0+
- 飞书开发者账号和应用
- OpenCode服务

### 安装依赖

```bash
bun install
```

### 配置环境变量

1. 复制环境变量文件：
```bash
cp .env.example .env
```

2. 编辑 `.env` 文件，填入必要的配置：
```env
# 飞书配置
FEISHU_APP_ID=your_app_id_here
FEISHU_APP_SECRET=your_app_secret_here

# OpenCode配置
OPENCODE_BASE_URL=http://127.0.0.1:4111

# 服务器配置
PORT=3000
HOST=0.0.0.0
```

### 运行项目

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

## OpenCode配置

确保OpenCode服务正在运行，并配置正确的基础URL。

## 开发指南

### 添加新功能

1. 在 `services/` 目录下创建新的服务模块
2. 在 `types/` 目录下定义相关类型
3. 在核心逻辑中集成新功能

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