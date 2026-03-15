import { FeishuService } from './feishu';
import { AgentProvider } from '../agent';
import { Logger, AppError } from '../utils';
import { appConfig } from '../config';
import { MessageContext } from '../types';

// Thread 会话信息
interface ThreadSession {
  sessionId: string; // Agent 会话ID
  openId: string; // 创建者的 open_id
  createdAt: number;
  lastActiveAt: number;
}

export class SageCore {
  private feishuService: FeishuService;
  private agent: AgentProvider;
  private logger: Logger;
  private isRunning: boolean = false;

  // Thread 隔离的会话管理
  private threadSessions: Map<string, ThreadSession> = new Map();

  constructor(agent: AgentProvider) {
    this.logger = new Logger('SageCore');
    this.agent = agent;
    this.feishuService = new FeishuService(appConfig.feishu);

    // 设置飞书消息处理器
    this.feishuService.setMessageHandler(this.handleFeishuMessage.bind(this));

    // 回复后飞书创建 thread 时，迁移 session 映射
    this.feishuService.setThreadCreatedHandler((messageId, threadId) => {
      const msgKey = `msg:${messageId}`;
      const session = this.threadSessions.get(msgKey);
      if (session) {
        this.threadSessions.set(threadId, session);
        this.threadSessions.delete(msgKey);
        this.logger.info(`迁移 thread 会话: ${msgKey} -> ${threadId} (session: ${session.sessionId})`);
      }
    });
  }

  // 处理飞书消息（主入口）
  private async handleFeishuMessage(ctx: MessageContext): Promise<string> {
    try {
      this.logger.info(`处理消息: openId=${ctx.openId}, threadId=${ctx.threadId || '无'}, text="${ctx.text}"`);

      // 检查是否为斜杠命令
      const commandResult = this.handleSlashCommand(ctx);
      if (commandResult !== null) {
        return commandResult;
      }

      // 预处理消息
      const processedMessage = this.preprocessMessage(ctx.text);

      // 获取或创建 Thread 对应的会话
      const sessionId = await this.getOrCreateThreadSession(ctx);

      // 发送到 Agent 处理
      const response = await this.agent.sendMessage(sessionId, processedMessage);

      // 后处理回复
      const processedResponse = this.postprocessResponse(response.text);

      // 更新最后活跃时间
      this.updateThreadActivity(ctx);

      this.logger.info(`处理完成，回复长度: ${processedResponse.length}`);
      return processedResponse;

    } catch (error) {
      this.logger.error('处理消息失败:', error);

      if (error instanceof AppError) {
        return `抱歉，处理消息时出现错误: ${error.message}`;
      }

      return '抱歉，处理消息时出现未知错误，请稍后再试';
    }
  }

  // 斜杠命令处理
  private handleSlashCommand(ctx: MessageContext): string | null {
    const text = ctx.text.trim();

    if (text === '/thread_id') {
      return this.cmdThreadId(ctx);
    }

    if (text === '/clear') {
      return this.cmdClear(ctx);
    }

    if (text === '/help') {
      return this.cmdHelp();
    }

    if (text === '/status') {
      return this.cmdStatus();
    }

    return null;
  }

  // /thread_id - 回复当前 THREAD ID
  private cmdThreadId(ctx: MessageContext): string {
    const threadKey = this.resolveThreadKey(ctx);
    const session = this.threadSessions.get(threadKey);

    if (ctx.threadId) {
      const info = [
        `Thread ID: ${ctx.threadId}`,
        `Agent Provider: ${this.agent.name}`,
        `Session: ${session?.sessionId || '未创建'}`,
        `创建者: ${session?.openId || 'N/A'}`,
        `创建时间: ${session ? new Date(session.createdAt).toLocaleString() : 'N/A'}`,
        `最后活跃: ${session ? new Date(session.lastActiveAt).toLocaleString() : 'N/A'}`,
      ];
      return info.join('\n');
    }

    return `当前不在话题中。消息 ID: ${ctx.messageId}`;
  }

  // /clear - 清空当前 thread 上下文
  private cmdClear(ctx: MessageContext): string {
    const threadKey = this.resolveThreadKey(ctx);
    const session = this.threadSessions.get(threadKey);

    if (session) {
      this.agent.deleteSession(session.sessionId).catch(err => {
        this.logger.error('删除 Agent 会话失败:', err);
      });
      this.threadSessions.delete(threadKey);
      this.logger.info(`清除 thread 会话: ${threadKey}`);
      return '已清空当前话题的上下文。下一条消息将开启新的对话。';
    }

    return '当前话题没有活跃的上下文。';
  }

  // /help - 帮助信息
  private cmdHelp(): string {
    return [
      '可用命令:',
      '',
      '/thread_id - 查看当前话题 ID 和会话信息',
      '/clear - 清空当前话题的上下文',
      '/status - 查看服务状态',
      '/help - 显示此帮助信息',
      '',
      '使用说明:',
      `• 当前 Agent: ${this.agent.name}`,
      '• 每条新消息会创建独立的话题上下文',
      '• 在话题中回复的消息共享同一上下文',
      '• 不同话题之间完全隔离',
    ].join('\n');
  }

  // /status - 服务状态
  private cmdStatus(): string {
    const status = this.getStatus();
    return [
      `Agent: ${this.agent.name}`,
      `运行中: ${status.isRunning ? '是' : '否'}`,
      `活跃话题: ${status.threadCount}`,
      `活跃会话: ${status.sessionCount}`,
    ].join('\n');
  }

  // 解析 thread key
  private resolveThreadKey(ctx: MessageContext): string {
    return ctx.threadId || `msg:${ctx.messageId}`;
  }

  // 获取或创建 Thread 对应的 Agent 会话
  private async getOrCreateThreadSession(ctx: MessageContext): Promise<string> {
    const threadKey = this.resolveThreadKey(ctx);

    const existing = this.threadSessions.get(threadKey);
    if (existing) {
      this.logger.info(`复用 thread 会话: ${threadKey} -> ${existing.sessionId}`);
      return existing.sessionId;
    }

    // 创建新会话
    const session = await this.agent.createSession();
    const now = Date.now();

    this.threadSessions.set(threadKey, {
      sessionId: session.id,
      openId: ctx.openId,
      createdAt: now,
      lastActiveAt: now,
    });

    this.logger.info(`创建新 thread 会话: ${threadKey} -> ${session.id} (provider: ${this.agent.name})`);
    return session.id;
  }

  // 更新 Thread 最后活跃时间
  private updateThreadActivity(ctx: MessageContext): void {
    const threadKey = this.resolveThreadKey(ctx);
    const session = this.threadSessions.get(threadKey);
    if (session) {
      session.lastActiveAt = Date.now();
    }
  }

  // 消息预处理
  private preprocessMessage(message: string): string {
    return message.trim();
  }

  // 回复后处理
  private postprocessResponse(response: string): string {
    if (response.length > 2000) {
      response = response.substring(0, 2000) + '...';
    }
    return response;
  }

  // 启动服务
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('服务已经在运行中');
      return;
    }

    try {
      this.logger.info(`正在启动 Sage (agent: ${this.agent.name})...`);

      // 初始化 Agent Provider
      await this.agent.initialize();

      // 启动飞书服务
      await this.feishuService.start();

      this.isRunning = true;
      this.logger.info('Sage 核心服务启动成功');

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
      this.logger.info('正在停止 Sage...');
      await this.feishuService.stop();
      await this.agent.destroy();
      this.isRunning = false;
      this.logger.info('Sage 已停止');
    } catch (error) {
      this.logger.error('停止服务失败:', error);
      throw error;
    }
  }

  // 设置清理任务
  private setupCleanupTask(): void {
    const cleanupInterval = 6 * 60 * 60 * 1000; // 6小时

    setInterval(async () => {
      try {
        const cleaned = await this.cleanupExpiredThreadSessions();
        if (cleaned > 0) {
          this.logger.info(`清理了 ${cleaned} 个过期 thread 会话`);
        }
      } catch (error) {
        this.logger.error('清理过期会话失败:', error);
      }
    }, cleanupInterval);

    this.logger.info('已设置会话清理任务');
  }

  // 清理过期的 Thread 会话
  private async cleanupExpiredThreadSessions(maxAge: number = 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [threadKey, session] of this.threadSessions.entries()) {
      if (now - session.lastActiveAt > maxAge) {
        this.agent.deleteSession(session.sessionId).catch(() => {});
        this.threadSessions.delete(threadKey);
        cleaned++;
      }
    }

    // 同时让 provider 清理自己的过期会话
    await this.agent.cleanupSessions(maxAge);

    return cleaned;
  }

  // 获取服务状态
  getStatus(): {
    isRunning: boolean;
    agentProvider: string;
    threadCount: number;
    sessionCount: number;
  } {
    return {
      isRunning: this.isRunning,
      agentProvider: this.agent.name,
      threadCount: this.threadSessions.size,
      sessionCount: this.agent.getActiveSessions().length,
    };
  }

  // 手动清理会话
  async cleanupSessions(): Promise<number> {
    return this.cleanupExpiredThreadSessions();
  }
}
