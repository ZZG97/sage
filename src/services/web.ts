import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { SageCore } from '../services/core';
import { AppError, Logger } from '../utils';
import { appConfig } from '../config';
import { mountApps } from '../apps';
import { existsSync } from 'fs';
import { join } from 'path';

export class WebServer {
  private app: Hono;
  private sageCore: SageCore;
  private port: number;
  private host: string;
  private logger = new Logger('WebServer');

  constructor(sageCore: SageCore) {
    this.sageCore = sageCore;
    this.port = appConfig.server.port;
    this.host = appConfig.server.host;

    this.app = new Hono();
    this.setupMiddleware();
    this.setupRoutes();
    mountApps(this.app, { sageCore });
    this.setupStaticServing();
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

    // 日志（排除静态资源）
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

        this.logger.info('收到飞书Webhook事件:', JSON.stringify(body, null, 2));

        return c.json({
          success: true,
          message: '事件已接收',
        });
      } catch (error) {
        this.logger.error('处理飞书Webhook失败:', error);
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

    // 根路径 — 如果有前端就 fallback 到 SPA，没有就返回 API 信息
    // (由 setupStaticServing 处理)
  }

  // 设置静态文件服务（前端 SPA）
  private setupStaticServing() {
    const webDistPath = join(process.cwd(), 'web/dist');
    const hasWebDist = existsSync(join(webDistPath, 'index.html'));

    if (hasWebDist) {
      // 静态资源（js/css/images）
      this.app.use('/assets/*', serveStatic({ root: './web/dist' }));

      // agent_home 上传文件（健康记录附件等）
      this.app.use('/uploads/*', serveStatic({ root: './agent_home/workspace' }));

      // SPA fallback: 非 API 路由返回 index.html
      const serveIndex = serveStatic({ root: './web/dist', path: '/index.html' });
      this.app.get('/', serveIndex);
      this.app.get('/management', serveIndex);
      this.app.get('/health-dashboard', serveIndex);
      this.app.get('/debug', serveIndex);

      this.logger.info(`前端已加载: ${webDistPath}`);
    } else {
      // 无前端，返回 API 信息
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
            apps: {
              health: '/apps/health',
              management: '/apps/management',
            },
          },
        });
      });
    }
  }

  // 设置错误处理
  private setupErrorHandling() {
    const webIndexPath = join(process.cwd(), 'web/dist/index.html');

    // 404处理
    this.app.notFound((c) => {
      // SPA fallback: 非 API/apps 路径尝试返回 index.html
      if (existsSync(webIndexPath) &&
          !c.req.path.startsWith('/apps/') &&
          !c.req.path.startsWith('/health') &&
          !c.req.path.startsWith('/status') &&
          !c.req.path.startsWith('/cleanup') &&
          !c.req.path.startsWith('/feishu/') &&
          !c.req.path.startsWith('/test/') &&
          !c.req.path.startsWith('/scheduler/')) {
        return new Response(Bun.file(webIndexPath), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      return c.json({
        error: 'Not Found',
        message: '请求的接口不存在',
        path: c.req.path,
      }, 404);
    });

    // 全局错误处理
    this.app.onError((err, c) => {
      this.logger.error('应用错误:', err);

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
      this.logger.info('正在启动Web服务...');

      // 使用Bun的服务器
      Bun.serve({
        port: this.port,
        hostname: this.host,
        fetch: this.app.fetch,
      });

      this.logger.info(`Web服务启动成功 http://${this.host}:${this.port}`);

    } catch (error) {
      this.logger.error('启动Web服务失败:', error);
      throw error;
    }
  }

  // 获取应用实例（用于测试）
  getApp(): Hono {
    return this.app;
  }
}
