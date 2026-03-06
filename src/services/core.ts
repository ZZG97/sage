import { FeishuService } from './feishu';
import { OpenCodeService } from './opencode';
import { Logger, AppError } from '../utils';
import { appConfig } from '../config';

export class SageCore {
  private feishuService: FeishuService;
  private opencodeService: OpenCodeService;
  private logger: Logger;
  private userSessions: Map<string, string> = new Map(); // userId -> sessionId
  private isRunning: boolean = false;

  constructor() {
    this.logger = new Logger('SageCore');
    this.feishuService = new FeishuService(appConfig.feishu);
    this.opencodeService = new OpenCodeService(appConfig.opencode.baseUrl);

    // 设置飞书消息处理器
    this.feishuService.setMessageHandler(this.handleFeishuMessage.bind(this));
  }

  // 处理飞书消息
  private async handleFeishuMessage(message: string): Promise<string> {
    try {
      this.logger.info(`处理飞书消息: ${message}`);

      // 这里可以添加消息预处理逻辑
      const processedMessage = this.preprocessMessage(message);

      // 获取或创建会话（这里简化处理，实际应该根据用户ID来管理会话）
      const sessionId = await this.getOrCreateSession('default');

      // 发送到OpenCode处理
      const response = await this.opencodeService.sendMessage(sessionId, processedMessage);

      // 后处理回复
      const processedResponse = this.postprocessResponse(response);

      this.logger.info(`处理完成，回复: ${processedResponse}`);
      return processedResponse;

    } catch (error) {
      this.logger.error('处理消息失败:', error);
      
      if (error instanceof AppError) {
        return `抱歉，处理消息时出现错误: ${error.message}`;
      }
      
      return '抱歉，处理消息时出现未知错误，请稍后再试';
    }
  }

  // 消息预处理
  private preprocessMessage(message: string): string {
    // 移除多余的空白字符
    message = message.trim();
    
    // 可以添加更多的预处理逻辑，比如：
    // - 敏感词过滤
    // - 命令解析
    // - 上下文补充
    
    return message;
  }

  // 回复后处理
  private postprocessResponse(response: string): string {
    // 可以添加回复优化逻辑，比如：
    // - 格式化回复
    // - 添加个性化内容
    // - 截断过长的回复
    
    if (response.length > 2000) {
      response = response.substring(0, 2000) + '...';
    }
    
    return response;
  }

  // 获取或创建会话
  private async getOrCreateSession(userId: string): Promise<string> {
    let sessionId = this.userSessions.get(userId);
    
    if (!sessionId) {
      const session = await this.opencodeService.createSession();
      sessionId = session.id;
      this.userSessions.set(userId, sessionId);
      this.logger.info(`为新用户 ${userId} 创建会话: ${sessionId}`);
    }
    
    return sessionId;
  }

  // 启动服务
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('服务已经在运行中');
      return;
    }

    try {
      this.logger.info('正在启动Sage核心服务...');

      // 启动飞书服务
      await this.feishuService.start();

      // 检查OpenCode服务状态
      const isHealthy = await this.opencodeService.healthCheck();
      if (!isHealthy) {
        throw new AppError('OpenCode服务健康检查失败', 'OPENCODE_UNHEALTHY');
      }

      this.isRunning = true;
      this.logger.info('Sage核心服务启动成功');

      // 设置定时任务清理过期会话
      this.setupCleanupTask();

    } catch (error) {
      this.logger.error('启动服务失败:', error);
      throw error;
    }
  }

  // 停止服务
  async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('服务未在运行');
      return;
    }

    try {
      this.logger.info('正在停止Sage核心服务...');

      // 停止飞书服务
      await this.feishuService.stop();

      this.isRunning = false;
      this.logger.info('Sage核心服务已停止');

    } catch (error) {
      this.logger.error('停止服务失败:', error);
      throw error;
    }
  }

  // 设置清理任务
  private setupCleanupTask(): void {
    // 每6小时清理一次过期会话
    const cleanupInterval = 6 * 60 * 60 * 1000;
    
    setInterval(() => {
      try {
        const cleaned = this.opencodeService.cleanupExpiredSessions();
        if (cleaned > 0) {
          this.logger.info(`清理了 ${cleaned} 个过期会话`);
        }
      } catch (error) {
        this.logger.error('清理过期会话失败:', error);
      }
    }, cleanupInterval);

    this.logger.info('已设置会话清理任务');
  }

  // 获取服务状态
  getStatus(): {
    isRunning: boolean;
    sessionCount: number;
    userCount: number;
  } {
    return {
      isRunning: this.isRunning,
      sessionCount: this.opencodeService.getAllSessions().length,
      userCount: this.userSessions.size,
    };
  }

  // 手动清理会话
  async cleanupSessions(): Promise<number> {
    const cleaned = this.opencodeService.cleanupExpiredSessions();
    
    // 清理用户会话映射
    const activeSessionIds = new Set(this.opencodeService.getAllSessions().map(s => s.id));
    for (const [userId, sessionId] of this.userSessions.entries()) {
      if (!activeSessionIds.has(sessionId)) {
        this.userSessions.delete(userId);
      }
    }

    this.logger.info(`手动清理完成，清理了 ${cleaned} 个会话`);
    return cleaned;
  }
}