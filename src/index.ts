import { SageCore } from './services/core';
import { WebServer } from './services/web';
import { validateConfig } from './config';
import { Logger } from './utils';

const logger = new Logger('Main');

class Application {
  private sageCore: SageCore;
  private webServer: WebServer;
  private isShuttingDown: boolean = false;

  constructor() {
    this.sageCore = new SageCore();
    this.webServer = new WebServer(this.sageCore);
  }

  async start(): Promise<void> {
    try {
      logger.info('正在启动Sage AI助手...');

      // 验证配置
      if (!validateConfig()) {
        logger.error('配置验证失败，请检查环境变量');
        process.exit(1);
      }

      // 启动核心服务
      await this.sageCore.start();

      // 启动Web服务
      await this.webServer.start();

      logger.info('Sage AI助手启动成功！');
      logger.info('服务正在运行，按 Ctrl+C 停止服务');

      // 设置进程信号处理
      this.setupSignalHandlers();

    } catch (error) {
      logger.error('启动失败:', error);
      process.exit(1);
    }
  }

  private setupSignalHandlers(): void {
    // 优雅关闭
    const gracefulShutdown = async (signal: string) => {
      if (this.isShuttingDown) {
        logger.warn('正在关闭中，请稍候...');
        return;
      }

      this.isShuttingDown = true;
      logger.info(`收到 ${signal} 信号，正在优雅关闭服务...`);

      try {
        // 停止核心服务
        await this.sageCore.stop();
        logger.info('核心服务已停止');

        // 这里可以添加其他清理工作
        logger.info('清理工作完成');

        logger.info('服务已完全停止');
        process.exit(0);

      } catch (error) {
        logger.error('关闭服务时出错:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // 未捕获的异常处理
    process.on('uncaughtException', (error) => {
      logger.error('未捕获的异常:', error);
      gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('未处理的Promise拒绝:', promise, '原因:', reason);
      gracefulShutdown('unhandledRejection');
    });

    // Windows系统支持
    if (process.platform === 'win32') {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.on('SIGINT', () => {
        process.emit('SIGINT');
      });
    }
  }
}

// 启动应用
async function main() {
  const app = new Application();
  await app.start();
}

// 运行应用
if (import.meta.main) {
  main().catch((error) => {
    logger.error('应用运行失败:', error);
    process.exit(1);
  });
}