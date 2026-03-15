import { SageCore } from './services/core';
import { WebServer } from './services/web';
import { validateConfig, getAgentConfig } from './config';
import { createAgentProvider } from './agent';
import { Logger } from './utils';

const logger = new Logger('Main');

class Application {
  private sageCore!: SageCore;
  private webServer!: WebServer;
  private isShuttingDown: boolean = false;

  async start(): Promise<void> {
    try {
      logger.info('正在启动 Sage AI 助手...');

      // 验证配置
      if (!validateConfig()) {
        logger.error('配置验证失败，请检查环境变量');
        process.exit(1);
      }

      // 创建 Agent Provider
      const agentConfig = getAgentConfig();
      const agent = createAgentProvider(agentConfig);
      logger.info(`使用 Agent Provider: ${agent.name}`);

      // 创建核心服务
      this.sageCore = new SageCore(agent);
      this.webServer = new WebServer(this.sageCore);

      // 启动
      await this.sageCore.start();
      await this.webServer.start();

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
        await this.sageCore.stop();
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
