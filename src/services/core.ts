import { FeishuService } from './feishu';
import { AgentProvider } from '../agent';
import type { HistoryStore } from './history-store';
import { Logger, AppError } from '../utils';
import { appConfig } from '../config';
import { MessageContext } from '../types';

export class SageCore {
  private feishuService: FeishuService;
  private agent: AgentProvider;
  private historyStore: HistoryStore;
  private logger: Logger;
  private isRunning: boolean = false;

  // 已在 provider 中恢复过的 session（避免重复 restoreSession）
  private restoredSessions: Set<string> = new Set();

  constructor(agent: AgentProvider, historyStore: HistoryStore) {
    this.logger = new Logger('SageCore');
    this.agent = agent;
    this.historyStore = historyStore;
    this.feishuService = new FeishuService(appConfig.feishu);

    // 设置飞书消息处理器
    this.feishuService.setMessageHandler(this.handleFeishuMessage.bind(this));

    // 回复后飞书创建 thread 时，迁移 session 映射
    this.feishuService.setThreadCreatedHandler((messageId, threadId) => {
      const msgKey = `msg:${messageId}`;
      this.historyStore.migrateSessionId(msgKey, threadId);
      this.logger.info(`迁移 thread 会话: ${msgKey} -> ${threadId}`);
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
      const threadKey = this.resolveThreadKey(ctx);
      const sessionId = await this.getOrCreateThreadSession(threadKey, ctx);

      // 记录用户消息（同时持久化 agentSessionId 映射）
      this.historyStore.saveUserMessage(threadKey, this.agent.name, processedMessage, {
        openId: ctx.openId,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        agentSessionId: sessionId,
      });

      // 发送到 Agent 处理
      const response = await this.agent.sendMessage(sessionId, processedMessage);

      // 检查是否发生了 fallback（新 sessionId 通过 metadata 传回）
      if (response.metadata?.newSessionId) {
        const newSessionId = response.metadata.newSessionId as string;
        this.historyStore.updateAgentSessionId(threadKey, newSessionId);
        this.restoredSessions.add(newSessionId);
        this.logger.info(`Fallback 更新会话: ${threadKey} -> ${newSessionId}`);
      }

      // 持久化 resume_id（SDK 会话 ID，用于重启恢复）
      const effectiveSessionId = (response.metadata?.newSessionId as string) ?? sessionId;
      const resumeId = this.agent.getResumeId(effectiveSessionId);
      if (resumeId) {
        this.historyStore.updateResumeId(threadKey, resumeId);
      }

      // 记录 agent 事件
      this.historyStore.saveAgentEvents(threadKey, this.agent.name, response.events);

      // 后处理回复
      const processedResponse = this.postprocessResponse(response.text);

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
    const session = this.historyStore.getSession(threadKey);

    if (ctx.threadId) {
      const info = [
        `Thread ID: ${ctx.threadId}`,
        `Agent Provider: ${this.agent.name}`,
        `Session: ${session?.agent_session_id || '未创建'}`,
        `创建者: ${session?.open_id || 'N/A'}`,
        `最后活跃: ${session?.last_active_at || 'N/A'}`,
      ];
      return info.join('\n');
    }

    return `当前不在话题中。消息 ID: ${ctx.messageId}`;
  }

  // /clear - 清空当前 thread 上下文
  private cmdClear(ctx: MessageContext): string {
    const threadKey = this.resolveThreadKey(ctx);
    const session = this.historyStore.getSession(threadKey);

    if (session?.agent_session_id) {
      this.agent.deleteSession(session.agent_session_id).catch(err => {
        this.logger.error('删除 Agent 会话失败:', err);
      });
      this.historyStore.clearSessionAgent(threadKey);
      this.restoredSessions.delete(session.agent_session_id);
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
      `活跃会话: ${status.sessionCount}`,
    ].join('\n');
  }

  // 解析 thread key
  private resolveThreadKey(ctx: MessageContext): string {
    return ctx.threadId || `msg:${ctx.messageId}`;
  }

  // 获取或创建 Thread 对应的 Agent 会话（DB 为唯一 source of truth）
  private async getOrCreateThreadSession(threadKey: string, ctx: MessageContext): Promise<string> {
    // 查 DB：该 threadKey 是否已有关联的 agent session
    const row = this.historyStore.getSession(threadKey);

    if (row?.agent_session_id) {
      // 懒恢复：首次使用时在 provider 侧注册
      if (!this.restoredSessions.has(row.agent_session_id)) {
        try {
          await this.agent.restoreSession(row.agent_session_id, row.resume_id || undefined);
          this.restoredSessions.add(row.agent_session_id);
          this.logger.info(`懒恢复会话: ${threadKey} -> ${row.agent_session_id}`);
        } catch (err) {
          this.logger.warn(`恢复会话失败，将创建新会话: ${row.agent_session_id}`, err);
          // 恢复失败，走下面的创建逻辑
          return this.createNewSession(threadKey, ctx);
        }
      } else {
        this.logger.info(`复用 thread 会话: ${threadKey} -> ${row.agent_session_id}`);
      }
      return row.agent_session_id;
    }

    // 没有已有 session，创建新的
    return this.createNewSession(threadKey, ctx);
  }

  // 创建新 agent session 并关联到 threadKey
  private async createNewSession(threadKey: string, ctx: MessageContext): Promise<string> {
    const session = await this.agent.createSession();
    this.restoredSessions.add(session.id);
    this.logger.info(`创建新 thread 会话: ${threadKey} -> ${session.id} (provider: ${this.agent.name})`);
    return session.id;
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
        await this.agent.cleanupSessions(24 * 60 * 60 * 1000);
        this.restoredSessions.clear(); // 清理后重置，下次使用会重新 restore
      } catch (error) {
        this.logger.error('清理过期会话失败:', error);
      }
    }, cleanupInterval);

    this.logger.info('已设置会话清理任务');
  }

  // 获取服务状态
  getStatus(): {
    isRunning: boolean;
    agentProvider: string;
    sessionCount: number;
  } {
    return {
      isRunning: this.isRunning,
      agentProvider: this.agent.name,
      sessionCount: this.agent.getActiveSessions().length,
    };
  }

  // 手动清理会话
  async cleanupSessions(): Promise<number> {
    const maxAge = 24 * 60 * 60 * 1000;
    const cleaned = await this.agent.cleanupSessions(maxAge);
    this.restoredSessions.clear();
    return cleaned;
  }
}
