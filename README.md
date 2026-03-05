# 飞书Echo Bot

这是一个基于飞书开放平台的自动回复机器人示例，参考了[飞书官方文档](https://open.feishu.cn/document/develop-an-echo-bot/explanation-of-example-code)。

## 功能特点

- 自动接收和回复文本消息
- 支持单聊和群聊场景
- 使用飞书官方Node.js SDK
- 基于Hono框架的轻量级实现

## 环境要求

- Node.js 16+ 或 Bun
- 飞书开发者账号和应用

## 安装依赖

```bash
npm install
# 或使用 bun
bun install
```

## 配置说明

1. 复制环境变量文件：
```bash
cp .env.example .env
```

2. 在飞书开放平台创建应用，获取以下配置：
   - APP_ID: 应用ID
   - APP_SECRET: 应用密钥
   - ENCRYPT_KEY: 事件加密密钥（可选）
   - VERIFICATION_TOKEN: 事件验证令牌（可选）

3. 配置飞书应用：
   - 设置事件订阅URL为：`https://your-domain.com/feishu/webhook`
   - 订阅`im.message.receive_v1`事件
   - 配置必要的权限

## 运行项目

```bash
# 使用 bun 运行
bun run index.ts

# 或使用 npm
npm run dev
```

## 接口说明

### POST /feishu/webhook
飞书事件回调接口，用于接收消息事件

### GET /health
健康检查接口

## 使用说明

1. 在飞书中与机器人对话，机器人会自动回复相同的消息
2. 在群聊中@机器人，机器人会回复被@的消息
3. 支持中英文双语回复

## 代码结构

```
index.ts          # 主程序文件
.env.example      # 环境变量示例
package.json      # 项目配置
```

## 注意事项

- 确保服务器能够被飞书平台访问
- 生产环境建议使用HTTPS
- 注意保护APP_SECRET等敏感信息

## 参考文档

- [飞书开放平台文档](https://open.feishu.cn/document)
- [飞书Node.js SDK](https://github.com/larksuite/node-sdk)
- [Hono框架](https://hono.dev/)