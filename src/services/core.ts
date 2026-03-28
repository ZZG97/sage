import { FeishuService } from './feishu';
import { AgentProvider } from '../agent';
import { FallbackAgentProvider } from '../agent/fallback-provider';
import type { AgentEvent } from '../agent/types';
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

    // 设置飞书消息处理器（不再返回 string，SageCore 自行控制卡片）
    this.feishuService.setMessageHandler(this.handleFeishuMessage.bind(this));

    // 为 FallbackAgentProvider 注入历史查询能力
    if (agent instanceof FallbackAgentProvider) {
      agent.setRecentHistoryFn((threadKey, maxTurns) =>
        this.historyStore.getRecentConversation(threadKey, maxTurns)
      );
    }

    // 注入 DB 去重（重启后兜底）
    this.feishuService.setDedupFn((eventId) => this.historyStore.isDuplicateEvent(eventId));

    // 回复后飞书创建 thread 时，迁移 session 映射
    this.feishuService.setThreadCreatedHandler((messageId, threadId) => {
      const msgKey = `msg:${messageId}`;
      this.historyStore.migrateSessionId(msgKey, threadId);
      this.logger.info(`迁移 thread 会话: ${msgKey} -> ${threadId}`);
    });
  }

  // 处理飞书消息（主入口）— 流式卡片生命周期
  private async handleFeishuMessage(ctx: MessageContext): Promise<void> {
    try {
      this.logger.info(`处理消息: openId=${ctx.openId}, threadId=${ctx.threadId || '无'}, text="${ctx.text.slice(0, 100)}"`);

      // 检查是否为斜杠命令
      const commandResult = this.handleSlashCommand(ctx);
      if (commandResult !== null) {
        // 命令结果用简单卡片回复
        await this.feishuService.replyCard(
          ctx.messageId,
          this.feishuService.buildStreamingCard([], false, commandResult),
        );
        return;
      }

      // 预处理消息
      const processedMessage = this.preprocessMessage(ctx.text);

      // 获取或创建 Thread 对应的会话
      const threadKey = this.resolveThreadKey(ctx);
      const sessionId = await this.getOrCreateThreadSession(threadKey, ctx);

      // 注册 session → thread 映射（供 FallbackAgentProvider 反查 threadKey）
      if (this.agent instanceof FallbackAgentProvider) {
        this.agent.registerSessionThread(sessionId, threadKey);
      }

      // 记录用户消息
      this.historyStore.saveUserMessage(threadKey, this.agent.name, processedMessage, {
        openId: ctx.openId,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        agentSessionId: sessionId,
      });

      // Step 1: 发送初始 "thinking" 卡片
      const initialCard = this.feishuService.buildStreamingCard([], true);
      const { messageId: replyMessageId } = await this.feishuService.replyCard(ctx.messageId, initialCard);

      if (!replyMessageId) {
        this.logger.error('发送初始卡片失败，无 messageId');
        return;
      }

      // Step 2: 流式处理 agent 消息
      const allEvents: AgentEvent[] = [];
      let resultText = '';
      let newSessionId: string | undefined;
      let lastPatchTime = 0;
      const PATCH_INTERVAL = 1500; // 最小 PATCH 间隔 ms，避免频率过高

      try {
        for await (const event of this.agent.sendMessageStream(sessionId, processedMessage)) {
          allEvents.push(event);

          // 检查 fallback metadata
          if ((event as any).metadata?.newSessionId) {
            newSessionId = (event as any).metadata.newSessionId;
          }

          if (event.type === 'result') {
            resultText = event.content || '';
            continue;
          }

          // 节流 PATCH：对可见事件（tool_call/thinking/text/notice）触发更新
          if (event.type === 'tool_call' || event.type === 'thinking' || event.type === 'text' || event.type === 'notice') {
            const now = Date.now();
            if (now - lastPatchTime >= PATCH_INTERVAL) {
              const card = this.feishuService.buildStreamingCard(allEvents, true);
              await this.feishuService.patchCard(replyMessageId, card).catch(err => {
                this.logger.warn('PATCH 卡片失败:', err);
              });
              lastPatchTime = now;
            }
          }
        }
      } catch (error: any) {
        this.logger.error('Agent 流式处理异常:', error);
        resultText = resultText || `处理出错: ${error.message}`;
      }

      // Step 3: 处理 fallback session 迁移
      if (newSessionId) {
        this.historyStore.updateAgentSessionId(threadKey, newSessionId);
        this.restoredSessions.add(newSessionId);
        this.logger.info(`Fallback 更新会话: ${threadKey} -> ${newSessionId}`);
      }

      // 持久化 resume_id
      const effectiveSessionId = newSessionId ?? sessionId;
      const resumeId = this.agent.getResumeId(effectiveSessionId);
      if (resumeId) {
        this.historyStore.updateResumeId(threadKey, resumeId);
      }

      // 记录 agent 事件
      this.historyStore.saveAgentEvents(threadKey, this.agent.name, allEvents);

      // Step 4: 最终卡片更新（处理图片 + 关闭流式）
      let finalText = resultText;
      try {
        finalText = await this.feishuService.processImagesInMarkdown(finalText);
      } catch (err) {
        this.logger.warn('处理回复中的图片失败:', err);
      }

      const finalCard = this.feishuService.buildStreamingCard(allEvents, false, finalText);
      await this.feishuService.patchCard(replyMessageId, finalCard).catch(err => {
        this.logger.warn('最终 PATCH 卡片失败:', err);
      });

      // Step 5: 发送本地文件附件
      try {
        await this.feishuService.sendLocalFileAttachments(replyMessageId, finalText);
      } catch (err) {
        this.logger.warn('发送文件附件失败:', err);
      }

      this.logger.info(`处理完成，回复长度: ${resultText.length}`);

    } catch (error) {
      this.logger.error('处理消息失败:', error);

      if (error instanceof AppError) {
        // 尝试发送错误卡片
        try {
          await this.feishuService.replyCard(
            ctx.messageId,
            this.feishuService.buildErrorCard(`抱歉，处理消息时出现错误: ${error.message}`),
          );
        } catch { /* ignore */ }
      }
    }
  }

  // ─── 斜杠命令 ───

  private handleSlashCommand(ctx: MessageContext): string | null {
    const text = ctx.text.trim();

    if (text === '/thread_id') return this.cmdThreadId(ctx);
    if (text === '/clear') return this.cmdClear(ctx);
    if (text === '/help') return this.cmdHelp();
    if (text === '/status') return this.cmdStatus();

    return null;
  }

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

  private cmdStatus(): string {
    const status = this.getStatus();
    return [
      `Agent: ${this.agent.name}`,
      `运行中: ${status.isRunning ? '是' : '否'}`,
      `活跃会话: ${status.sessionCount}`,
    ].join('\n');
  }

  // ─── 会话管理 ───

  private resolveThreadKey(ctx: MessageContext): string {
    return ctx.threadId || `msg:${ctx.messageId}`;
  }

  private async getOrCreateThreadSession(threadKey: string, ctx: MessageContext): Promise<string> {
    const row = this.historyStore.getSession(threadKey);

    if (row?.agent_session_id) {
      if (!this.restoredSessions.has(row.agent_session_id)) {
        try {
          await this.agent.restoreSession(row.agent_session_id, row.resume_id || undefined);
          this.restoredSessions.add(row.agent_session_id);
          this.logger.info(`懒恢复会话: ${threadKey} -> ${row.agent_session_id}`);
        } catch (err) {
          this.logger.warn(`恢复会话失败，将创建新会话: ${row.agent_session_id}`, err);
          return this.createNewSession(threadKey, ctx);
        }
      } else {
        this.logger.info(`复用 thread 会话: ${threadKey} -> ${row.agent_session_id}`);
      }
      return row.agent_session_id;
    }

    return this.createNewSession(threadKey, ctx);
  }

  private async createNewSession(threadKey: string, ctx: MessageContext): Promise<string> {
    const session = await this.agent.createSession();
    this.restoredSessions.add(session.id);
    this.logger.info(`创建新 thread 会话: ${threadKey} -> ${session.id} (provider: ${this.agent.name})`);
    return session.id;
  }

  private preprocessMessage(message: string): string {
    return message.trim();
  }

  // ─── 服务生命周期 ───

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('服务已经在运行中');
      return;
    }

    try {
      this.logger.info(`正在启动 Sage (agent: ${this.agent.name})...`);
      await this.agent.initialize();
      await this.feishuService.start();
      this.isRunning = true;
      this.logger.info('Sage 核心服务启动成功');
      this.setupCleanupTask();
    } catch (error) {
      this.logger.error('启动服务失败:', error);
      throw error;
    }
  }

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
    }
  }

  private setupCleanupTask(): void {
    const cleanupInterval = 6 * 60 * 60 * 1000;

    setInterval(async () => {
      try {
        await this.agent.cleanupSessions(24 * 60 * 60 * 1000);
        this.restoredSessions.clear();
        this.historyStore.cleanupProcessedEvents();
      } catch (error) {
        this.logger.error('清理过期会话失败:', error);
      }
    }, cleanupInterval);

    this.logger.info('已设置会话清理任务');
  }

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

  async cleanupSessions(): Promise<number> {
    const maxAge = 24 * 60 * 60 * 1000;
    const cleaned = await this.agent.cleanupSessions(maxAge);
    this.restoredSessions.clear();
    return cleaned;
  }
}
