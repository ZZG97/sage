import { SageCore } from './services/core';
import { WebServer } from './services/web';
import { HistoryStore } from './services/history-store';
import { Scheduler } from './services/scheduler';
import { registerTasks } from './services/tasks';
import { validateConfig, getAgentConfig, getFallbackAgentConfig } from './config';
import { createAgentProvider } from './agent';
import { Logger } from './utils';

const logger = new Logger('Main');

class Application {
  private sageCore!: SageCore;
  private webServer!: WebServer;
  private historyStore!: HistoryStore;
  private scheduler!: Scheduler;
  private isShuttingDown: boolean = false;

  async start(): Promise<void> {
    try {
      logger.info('正在启动 Sage AI 助手...');

      // 验证配置
      if (!validateConfig()) {
        logger.error('配置验证失败，请检查环境变量');
        process.exit(1);
      }

      // 创建 Agent Provider（支持 fallback）
      const agentConfig = getAgentConfig();
      const fallbackConfig = getFallbackAgentConfig();
      const agent = createAgentProvider(agentConfig, fallbackConfig);
      logger.info(`使用 Agent Provider: ${agent.name}`);

      // 创建 HistoryStore（默认路径 data/history.db）
      const env = process.env.NODE_ENV === 'development' ? 'dev' : 'production';
      this.historyStore = new HistoryStore(undefined, env);

      // 创建核心服务
      this.sageCore = new SageCore(agent, this.historyStore);
      this.webServer = new WebServer(this.sageCore);

      // 创建调度器
      this.scheduler = new Scheduler({
        agent,
        logger: new Logger('Task'),
      });
      registerTasks(this.scheduler);

      // 启动
      await this.sageCore.start();
      await this.webServer.start();
      this.scheduler.start();

      logger.info('Sage AI 助手启动成功！');
      logger.info('服务正在运行，按 Ctrl+C 停止服务');

      this.setupSignalHandlers();

    } catch (error) {
      logger.error('启动失败:', error);
      process.exit(1);
    }
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
        this.scheduler.stop();
        await this.sageCore.stop();
        this.historyStore.destroy();
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
