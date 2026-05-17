import { SageCore } from './services/core';
import { WebServer } from './services/web';
import { HistoryStore } from './services/history-store';
import { TaskScheduler } from './services/task-scheduler';
import { getBuiltinTasks } from './services/tasks';
import { registerSchedulerRoutes } from './apps/management/routes';
import { validateConfig, getAgentConfig, getAllAvailableProviderConfigs } from './config';
import { createAgentProvider } from './agent';
import { Logger } from './utils';
import { closeAllDatabases } from './shared/db';

const logger = new Logger('Main');

class Application {
  private sageCore!: SageCore;
  private webServer!: WebServer;
  private historyStore!: HistoryStore;
  private scheduler!: TaskScheduler;
  private isShuttingDown: boolean = false;

  async start(): Promise<void> {
    try {
      logger.info('正在启动 Sage AI 助手...');

      // 验证配置
      if (!validateConfig()) {
        logger.error('配置验证失败，请检查环境变量');
        process.exit(1);
      }

      // 创建 Agent Provider（所有可用的 provider，第一个为默认活跃）
      const agentConfig = getAgentConfig();
      const allConfigs = getAllAvailableProviderConfigs(agentConfig.type);
      const agent = createAgentProvider(allConfigs);
      logger.info(`使用 Agent Provider: ${agent.name}`);

      // 创建 HistoryStore（默认路径 data/history.db）
      const env = process.env.NODE_ENV === 'development' ? 'dev' : 'production';
      this.historyStore = new HistoryStore(undefined, env);

      // 创建核心服务
      this.sageCore = new SageCore(agent, this.historyStore);

      // 创建调度器（bunqueue-based）
      const isDev = env === 'dev';
      const ownerOpenId = process.env.OWNER_OPEN_ID || '';
      this.scheduler = new TaskScheduler({
        agent,
        logger: new Logger('Task'),
        sendMessageToOwner: ownerOpenId
          ? (text: string) => this.sageCore.sendProactiveMessage(ownerOpenId, text)
          : undefined,
        runAgentTask: ownerOpenId
          ? (prompt: string, title?: string, options?: { reuseConversationId?: string }) =>
            this.sageCore.runAgentForOwner(prompt, ownerOpenId, title, options)
          : undefined,
      }, isDev);
      if (!ownerOpenId) {
        logger.warn('OWNER_OPEN_ID 未配置，主动消息功能不可用');
      }

      // Web server 依赖 app context（含 scheduler）
      this.webServer = new WebServer(this.sageCore, this.scheduler);

      // 兼容旧 scheduler skill，保留根路径别名
      this.setupSchedulerRoutes();

      // 启动
      await this.sageCore.start();
      await this.webServer.start();
      await this.scheduler.start(getBuiltinTasks());

      logger.info('Sage AI 助手启动成功！');
      logger.info('服务正在运行，按 Ctrl+C 停止服务');

      this.setupSignalHandlers();

    } catch (error) {
      logger.error('启动失败:', error);
      process.exit(1);
    }
  }

  private setupSchedulerRoutes(): void {
    registerSchedulerRoutes(this.webServer.getApp(), this.scheduler);

    // 兼容旧 scheduler skill 的 run-now 路径
    this.webServer.getApp().post('/scheduler/run/:name', async (c) => {
      const name = c.req.param('name');
      try {
        await this.scheduler.runNow(name);
        return c.json({ success: true, task: name });
      } catch (error) {
        return c.json({ success: false, error: String(error) }, 500);
      }
    });
  }

  private setupSignalHandlers(): void {
    const gracefulShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn('正在关闭中，请稍候...');
        return;
      }

      this.isShuttingDown = true;
      logger.info(`收到 ${signal} 信号，正在优雅关闭服务...`);

      try {
        await this.scheduler.stop();
        await this.sageCore.stop();
        this.historyStore.destroy();
        closeAllDatabases();
        logger.info('服务已完全停止');
        process.exit(0);
      } catch (error) {
        logger.error('关闭服务时出错:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    process.on('uncaughtException', (error) => {
      logger.error('未捕获的异常:', error);
      gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('未处理的 Promise 拒绝:', promise, '原因:', reason);
      gracefulShutdown('unhandledRejection');
    });

    if (process.platform === 'win32') {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.on('SIGINT', () => { process.emit('SIGINT'); });
    }
  }
}

// 启动应用
if (import.meta.main) {
  const app = new Application();
  app.start().catch((error) => {
    logger.error('应用运行失败:', error);
    process.exit(1);
  });
}
