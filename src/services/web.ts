import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { SageCore } from '../services/core';
import { AppError } from '../utils';
import { appConfig } from '../config';

export class WebServer {
  private app: Hono;
  private sageCore: SageCore;
  private port: number;
  private host: string;

  constructor(sageCore: SageCore) {
    this.sageCore = sageCore;
    this.port = appConfig.server.port;
    this.host = appConfig.server.host;
    
    this.app = new Hono();
    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  // 设置中间件
  private setupMiddleware() {
    // CORS
    this.app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }));

    // 日志
    this.app.use('*', logger());
  }

  // 设置路由
  private setupRoutes() {
    // 健康检查
    this.app.get('/health', async (c) => {
      const status = this.sageCore.getStatus();
      
      return c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services: status,
      });
    });

    // 服务状态
    this.app.get('/status', async (c) => {
      const status = this.sageCore.getStatus();
      return c.json(status);
    });

    // 手动清理会话
    this.app.post('/cleanup', async (c) => {
      try {
        const cleaned = await this.sageCore.cleanupSessions();
        return c.json({
          success: true,
          cleaned,
          message: `清理了 ${cleaned} 个过期会话`,
        });
      } catch (error) {
        return c.json({
          success: false,
          error: error instanceof Error ? error.message : '清理失败',
        }, 500);
      }
    });

    // 飞书Webhook（备用，主要使用WebSocket）
    this.app.post('/feishu/webhook', async (c) => {
      try {
        const body = await c.req.json();
        
        // 验证请求（如果需要）
        // const signature = c.req.header('X-Lark-Signature');
        // const timestamp = c.req.header('X-Lark-Request-Timestamp');
        
        // 处理飞书事件
        console.log('收到飞书Webhook事件:', JSON.stringify(body, null, 2));
        
        return c.json({
          success: true,
          message: '事件已接收',
        });
      } catch (error) {
        console.error('处理飞书Webhook失败:', error);
        return c.json({
          success: false,
          error: '处理失败',
        }, 500);
      }
    });

    // 测试接口 - 发送消息
    this.app.post('/test/message', async (c) => {
      try {
        const { message } = await c.req.json();
        
        if (!message || typeof message !== 'string') {
          return c.json({
            success: false,
            error: '消息不能为空',
          }, 400);
        }

        // 这里可以添加测试逻辑
        return c.json({
          success: true,
          message: '测试消息已接收',
          data: {
            originalMessage: message,
            processedMessage: message.trim(),
          },
        });
      } catch (error) {
        return c.json({
          success: false,
          error: error instanceof Error ? error.message : '处理失败',
        }, 500);
      }
    });

    // 根路径
    this.app.get('/', (c) => {
      return c.json({
        name: 'Sage AI Assistant',
        version: '1.0.0',
        description: '个人内部AI助手，通过飞书交互，集成OpenCode AI能力',
        endpoints: {
          health: '/health',
          status: '/status',
          cleanup: '/cleanup',
          feishuWebhook: '/feishu/webhook',
          testMessage: '/test/message',
        },
      });
    });
  }

  // 设置错误处理
  private setupErrorHandling() {
    // 404处理
    this.app.notFound((c) => {
      return c.json({
        error: 'Not Found',
        message: '请求的接口不存在',
        path: c.req.path,
      }, 404);
    });

    // 全局错误处理
    this.app.onError((err, c) => {
      console.error('应用错误:', err);
      
      if (err instanceof AppError) {
        return c.json({
          error: err.code,
          message: err.message,
          statusCode: err.statusCode,
        }, err.statusCode as any);
      }

      return c.json({
        error: 'INTERNAL_ERROR',
        message: '内部服务器错误',
        statusCode: 500,
      }, 500);
    });
  }

  // 启动Web服务
  async start(): Promise<void> {
    try {
      console.log(`正在启动Web服务...`);
      
      // 使用Bun的服务器
      Bun.serve({
        port: this.port,
        hostname: this.host,
        fetch: this.app.fetch,
      });

      console.log(`Web服务启动成功`);
      console.log(`服务地址: http://${this.host}:${this.port}`);
      console.log(`健康检查: http://${this.host}:${this.port}/health`);
      console.log(`服务状态: http://${this.host}:${this.port}/status`);
      
    } catch (error) {
      console.error('启动Web服务失败:', error);
      throw error;
    }
  }

  // 获取应用实例（用于测试）
  getApp(): Hono {
    return this.app;
  }
}