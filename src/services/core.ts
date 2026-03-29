import { FeishuService } from './feishu';
import { AgentProvider } from '../agent';
import { FallbackAgentProvider } from '../agent/fallback-provider';
import type { AgentEvent } from '../agent/types';
import type { HistoryStore } from './history-store';
import { Logger, AppError } from '../utils';
import { appConfig } from '../config';
import { MessageContext } from '../types';
import { execSync } from 'child_process';

export class SageCore {
  private feishuService: FeishuService;
  private agent: AgentProvider;
  private historyStore: HistoryStore;
  private logger: Logger;
  private isRunning: boolean = false;
  private isDraining: boolean = false;

  // 活跃卡片追踪：replyMessageId -> { threadKey, startTime }
  private activeCards: Map<string, { threadKey: string; startTime: number }> = new Map();

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
    // 正在关闭中，拒绝新消息
    if (this.isDraining) {
      this.logger.info(`服务正在关闭，忽略消息: ${ctx.messageId}`);
      try {
        await this.feishuService.replyCard(
          ctx.messageId,
          this.feishuService.buildStreamingCard([], false, '⚠️ 服务正在重启，请稍后重试。'),
        );
      } catch { /* best effort */ }
      return;
    }

    try {
      this.logger.info(`处理消息: openId=${ctx.openId}, threadId=${ctx.threadId || '无'}, text="${ctx.text.slice(0, 100)}"`);

      // 检查是否为斜杠命令
      const commandResult = this.handleSlashCommand(ctx);
      if (commandResult === 'async') return; // 异步命令，已自行处理
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

      // 追踪活跃卡片
      this.activeCards.set(replyMessageId, { threadKey, startTime: Date.now() });

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

      // 移除活跃卡片追踪
      this.activeCards.delete(replyMessageId);

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

  private handleSlashCommand(ctx: MessageContext): string | null | 'async' {
    const text = ctx.text.trim();

    if (text === '/thread_id') return this.cmdThreadId(ctx);
    if (text === '/clear') return this.cmdClear(ctx);
    if (text === '/help') return this.cmdHelp();
    if (text === '/status') return this.cmdStatus();
    if (text === '/restart') {
      this.cmdRestart(ctx);
      return 'async';
    }

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

  private async cmdRestart(ctx: MessageContext): Promise<void> {
    const processName = process.env.name || appConfig.processName || 'sage';
    this.logger.info(`收到 /restart 命令，准备优雅重启 (process: ${processName})`);

    // 立即回复确认（这张卡片独立，不进 activeCards）
    const { messageId: restartCardMsgId } = await this.feishuService.replyCard(
      ctx.messageId,
      this.feishuService.buildStreamingCard([], false,
        `🔄 正在优雅重启...\n活跃卡片: ${this.activeCards.size}，等待处理完成后重启。`),
    );

    // Step 1: drain — 拒绝新消息，等待活跃卡片完成
    this.isDraining = true;
    this.logger.info(`/restart: 进入 drain 模式，活跃卡片: ${this.activeCards.size}`);

    const DRAIN_TIMEOUT = 30_000;
    if (this.activeCards.size > 0) {
      const drainStart = Date.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.activeCards.size === 0) {
            this.logger.info('/restart: 所有活跃卡片已完成');
            resolve();
            return;
          }
          if (Date.now() - drainStart >= DRAIN_TIMEOUT) {
            this.logger.warn(`/restart: drain 超时，剩余 ${this.activeCards.size} 张`);
            resolve();
            return;
          }
          setTimeout(check, 500);
        };
        check();
      });
    }

    // Step 2: 给残留卡片发 shutdown PATCH，然后清空追踪
    if (this.activeCards.size > 0) {
      const shutdownCard = this.feishuService.buildStreamingCard(
        [], false, '⚠️ 服务正在重启，当前对话已中断。请重新发送消息继续。'
      );
      await Promise.allSettled(
        Array.from(this.activeCards.keys()).map(msgId =>
          this.feishuService.patchCard(msgId, shutdownCard).catch(() => {})
        )
      );
      this.activeCards.clear();
    }

    // Step 3: 更新重启确认卡片为完成状态
    const doneCard = this.feishuService.buildStreamingCard(
      [], false, '✅ 服务即将重启，请稍后发送消息继续。'
    );
    await this.feishuService.patchCard(restartCardMsgId, doneCard).catch(() => {});

    // Step 4: 调 pm2 restart，然后进程会被新实例替换
    this.logger.info(`/restart: drain 完成，执行 pm2 restart ${processName}`);
    try {
      // 等待 drain 完成后再 restart，避免 pm2 kill 时 activeCards 还未清空
      execSync(`pm2 restart ${processName}`, { timeout: 10_000 });
    } catch {
      // restart 会杀自己，这里大概率不会执行到
    }
  }

  private cmdHelp(): string {
    return [
      '可用命令:',
      '',
      '/thread_id - 查看当前话题 ID 和会话信息',
      '/clear - 清空当前话题的上下文',
      '/status - 查看服务状态',
      '/restart - 优雅重启服务（等待活跃任务完成后重启）',
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
    const lines = [
      `Agent: ${this.agent.name}`,
      `运行中: ${status.isRunning ? '是' : '否'}`,
      `活跃会话: ${status.sessionCount}`,
      `活跃卡片: ${this.activeCards.size}`,
    ];
    if (this.isDraining) lines.push('⚠️ 服务正在关闭中 (drain)');
    return lines.join('\n');
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

    // 注册信号处理，优雅退出
    const shutdown = async (signal: string) => {
      this.logger.info(`收到 ${signal}，开始优雅关闭...`);
      await this.stop();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

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

    const DRAIN_TIMEOUT = 30_000; // 最多等 30s

    try {
      this.logger.info('正在停止 Sage...');

      // Step 1: 进入 drain 模式，拒绝新消息
      this.isDraining = true;
      this.logger.info(`进入 drain 模式，当前活跃卡片: ${this.activeCards.size}`);

      // Step 2: 等待活跃卡片完成（超时强制退出）
      if (this.activeCards.size > 0) {
        const drainStart = Date.now();
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.activeCards.size === 0) {
              this.logger.info('所有活跃卡片已完成');
              resolve();
              return;
            }
            if (Date.now() - drainStart >= DRAIN_TIMEOUT) {
              this.logger.warn(`drain 超时 (${DRAIN_TIMEOUT}ms)，剩余 ${this.activeCards.size} 张活跃卡片`);
              resolve();
              return;
            }
            setTimeout(check, 500);
          };
          check();
        });
      }

      // Step 3: 给仍在活跃的卡片发 shutdown PATCH
      if (this.activeCards.size > 0) {
        this.logger.info(`正在关闭 ${this.activeCards.size} 张残留卡片...`);
        const shutdownCard = this.feishuService.buildStreamingCard(
          [], false, '⚠️ 服务正在重启，当前对话已中断。请重新发送消息继续。'
        );
        const patchPromises = Array.from(this.activeCards.keys()).map(messageId =>
          this.feishuService.patchCard(messageId, shutdownCard).catch(err => {
            this.logger.warn(`shutdown PATCH 失败: ${messageId}`, err);
          })
        );
        await Promise.allSettled(patchPromises);
        this.activeCards.clear();
      }

      // Step 4: 停止服务
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
