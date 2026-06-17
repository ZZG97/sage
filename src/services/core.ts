import { AgentProvider } from '../agent';
import { FallbackAgentProvider } from '../agent/fallback-provider';
import type { HistoryStore } from './history-store';
import { Logger, AppError, patchRequestContext, sanitizeLogValue } from '../utils';
import { appConfig } from '../config';
import { MessageContext } from '../types';
import { execSync } from 'child_process';
import type { MessageGateway, ResponseAnchor } from './message-gateway';
import { ConversationRouter } from './conversation-router';
import { executeAgentTurn, type ActiveRun, type RunAgentTurnResult } from './agent-turn-runner';
import {
  buildRestartStartText,
  getRestartExecutorCommand,
  handleSlashCommand,
  RESTART_COMPLETE_TEXT,
  RESTART_INTERRUPTED_TEXT,
  type SlashCommandRuntime,
  type SlashRestartRejectReason,
  type SlashRuntimeStatus,
  type SlashThreadInfo,
} from './slash-commands';

// ─── 常量 ───
const DRAIN_TIMEOUT = 30_000; // drain 最多等 30s
const MAX_SESSION_AGE = 24 * 60 * 60 * 1000; // 会话最大存活时间 24h
const DEFAULT_PROACTIVE_TOPIC = 'Sage 主动任务';

interface RunAgentForOwnerOptions {
  reuseConversationId?: string;
}

interface SageCoreOptions {
  restartExecutor?: (command: string) => void;
}

export class SageCore {
  private messageGateway: MessageGateway;
  private agent: AgentProvider;
  private historyStore: HistoryStore;
  private logger: Logger;
  private conversationRouter: ConversationRouter;
  private restartExecutor: (command: string) => void;
  private slashCommandRuntime: SlashCommandRuntime;
  private isRunning: boolean = false;
  private isDraining: boolean = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  // 当前正在执行的 agent run。用于把撤回的用户消息映射到正在跑的任务。
  private activeRuns: Map<string, ActiveRun> = new Map();

  // 已在 provider 中恢复过的 session（避免重复 restoreSession）
  private restoredSessions: Set<string> = new Set();

  // per-conversation 消息排队：正在处理的 conversation + 排队中的消息
  private processingConversations: Set<string> = new Set();
  private pendingMessages: Map<string, MessageContext[]> = new Map();

  constructor(
    agent: AgentProvider,
    historyStore: HistoryStore,
    messageGateway: MessageGateway,
    options: SageCoreOptions = {},
  ) {
    this.logger = new Logger('SageCore');
    this.agent = agent;
    this.historyStore = historyStore;
    this.messageGateway = messageGateway;
    this.conversationRouter = new ConversationRouter(this.historyStore, this.logger);
    this.restartExecutor = options.restartExecutor ?? ((command: string) => {
      execSync(command, { timeout: 10_000 });
    });
    this.slashCommandRuntime = this.createSlashCommandRuntime();

    // 设置消息处理器（不再返回 string，SageCore 自行控制输出生命周期）
    this.messageGateway.setMessageHandler(this.handleIncomingMessage.bind(this));
    this.messageGateway.setMessageRecallHandler(this.handleMessageRecall.bind(this));

    // 为 FallbackAgentProvider 注入历史查询能力
    if (agent instanceof FallbackAgentProvider) {
      agent.setRecentHistoryFn((conversationId, maxTurns) =>
        this.historyStore.getRecentConversation(conversationId, maxTurns)
      );
    }

    // 注入 DB 去重（重启后兜底）
    this.messageGateway.setDedupFn((eventId) => this.historyStore.isDuplicateEvent(eventId));
  }

  // 处理用户消息（主入口）— 排队 + 流式卡片生命周期
  async handleIncomingMessage(ctx: MessageContext): Promise<void> {
    // 正在关闭中，拒绝新消息
    if (this.isDraining) {
      this.logger.info(`服务正在关闭，忽略消息: ${ctx.messageId}`);
      try {
        await this.messageGateway
          .createResponder({ kind: 'reply', parentMessageId: ctx.messageId })
          .complete({ events: [], text: '⚠️ 服务正在重启，请稍后重试。' });
      } catch { /* best effort */ }
      return;
    }

    // 斜杠命令不排队，立即处理
    const commandResult = handleSlashCommand(ctx, this.slashCommandRuntime);
    if (commandResult?.kind === 'async') return;
    if (commandResult?.kind === 'reply') {
      await this.messageGateway
        .createResponder({ kind: 'reply', parentMessageId: ctx.messageId })
        .complete({ events: [], text: commandResult.text });
      return;
    }

    const conversationId = this.conversationRouter.getOrCreateConversation(ctx, this.agent.name);
    patchRequestContext({ conversationId, messageId: ctx.messageId });

    // 如果该 conversation 正在处理中，排队等待
    if (this.processingConversations.has(conversationId)) {
      const queue = this.pendingMessages.get(conversationId) || [];
      queue.push(ctx);
      this.pendingMessages.set(conversationId, queue);
      this.conversationRouter.rememberMessageConversation(ctx.messageId, conversationId);
      this.logger.info(`消息排队: conv=${conversationId}, queue=${queue.length}, preview="${sanitizeLogValue(ctx.text, 50)}"`);
      return; // 不阻塞，当前处理完后会自动消费队列
    }

    // 标记开始处理。内部状态只使用稳定的 conversationId。
    this.processingConversations.add(conversationId);

    try {
      await this.processThreadMessage(ctx, conversationId);

      // 处理完后消费队列中的排队消息
      while (true) {
        const queue = this.pendingMessages.get(conversationId);
        if (!queue || queue.length === 0) {
          this.pendingMessages.delete(conversationId);
          break;
        }

        // 取出所有排队消息，合并成一条
        const queuedMessages = queue.splice(0);
        this.pendingMessages.delete(conversationId);

        const mergedText = queuedMessages.map(m => this.preprocessMessage(m.text)).join('\n');
        const lastCtx = queuedMessages[queuedMessages.length - 1]; // 用最后一条消息的 ctx 回复
        const hint = queuedMessages.length === 1
          ? `[用户在你处理上一条消息期间追加了1条新消息]\n\n`
          : `[用户在你处理上一条消息期间追加了${queuedMessages.length}条新消息]\n\n`;

        this.logger.info(`消费排队消息: conv=${conversationId}, count=${queuedMessages.length}`);

        // 构造合并后的 ctx 用于处理
        const mergedCtx: MessageContext = { ...lastCtx, text: hint + mergedText };
        await this.processThreadMessage(
          mergedCtx,
          conversationId,
          queuedMessages.map(m => m.messageId),
        );
      }
    } finally {
      this.processingConversations.delete(conversationId);
    }
  }

  // 实际处理单条（或合并后的）消息
  private async processThreadMessage(
    ctx: MessageContext,
    conversationId: string,
    sourceMessageIds: string[] = [ctx.messageId],
  ): Promise<void> {
    try {
      this.conversationRouter.rememberMessageConversation(ctx.messageId, conversationId);
      this.logger.info(
        `处理消息: conv=${conversationId}, msg=${ctx.messageId}, open=${ctx.openId}, thread=${ctx.threadId || '无'}, textLen=${ctx.text.length}, preview="${sanitizeLogValue(ctx.text, 100)}"`
      );

      // 预处理消息
      let processedMessage = this.preprocessMessage(ctx.text);

      // 获取或创建 Thread 对应的会话
      const { sessionId, isNew } = await this.getOrCreateAgentSession(conversationId);
      patchRequestContext({
        conversationId,
        messageId: ctx.messageId,
        sessionId,
        provider: this.getProviderNameForSession(sessionId),
      });

      // 仅在新会话首条消息时注入主动消息上下文（避免 thread 内每条消息都重复注入）
      const replyRootMessageId = ctx.rootId ?? ctx.parentId;
      if (isNew && replyRootMessageId) {
        const proactiveContent = this.historyStore.getProactiveMessage(replyRootMessageId);
        if (proactiveContent) {
          processedMessage = `[bot之前主动发给user的消息: "${proactiveContent}"  后续是user的新消息]\n\n${processedMessage}`;
          this.logger.info(`注入主动消息上下文: rootMessageId=${replyRootMessageId}`);
        }
      }

      // 注册 agent session → conversation 映射（供 FallbackAgentProvider 注入历史上下文）
      if (this.agent instanceof FallbackAgentProvider) {
        this.agent.registerSessionConversation(sessionId, conversationId);
      }

      // 记录用户消息
      this.historyStore.saveUserMessage(conversationId, this.agent.name, processedMessage, {
        openId: ctx.openId,
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        agentSessionId: sessionId,
      });

      await this.runAgentTurn({
        prompt: processedMessage,
        conversationId,
        sessionId,
        sourceMessageIds,
        anchor: { kind: 'reply', parentMessageId: ctx.messageId },
      });

    } catch (error) {
      this.logger.error('处理消息失败:', error);

      if (error instanceof AppError) {
        try {
          await this.messageGateway
            .createResponder({ kind: 'reply', parentMessageId: ctx.messageId })
            .fail(`抱歉，处理消息时出现错误: ${error.message}`);
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * 跑一次 assistant turn。Core 只处理 Sage 状态机；用户可见输出交给 responder。
   */
  private async runAgentTurn(opts: {
    prompt: string;
    conversationId: string;
    sessionId: string;
    sourceMessageIds?: string[];
    anchor: ResponseAnchor;
  }): Promise<RunAgentTurnResult> {
    const { prompt, conversationId, sessionId, sourceMessageIds, anchor } = opts;
    if (anchor.kind === 'reply') {
      this.conversationRouter.rememberMessageConversation(anchor.parentMessageId, conversationId);
    }

    return executeAgentTurn({
      prompt,
      conversationId,
      sessionId,
      sourceMessageIds,
      anchor,
      agent: this.agent,
      createResponder: (anchor) => this.messageGateway.createResponder(anchor),
      activeRuns: {
        set: (conversationId, activeRun) => {
          this.activeRuns.set(conversationId, activeRun);
        },
        deleteIfCurrent: (conversationId, activeRun) => {
          if (this.activeRuns.get(conversationId) === activeRun) {
            this.activeRuns.delete(conversationId);
          }
        },
      },
      bindResponse: (binding, conversationId) => {
        this.conversationRouter.bindResponseToConversation(binding, conversationId);
      },
      buildAgentSessionContext: (conversationId) => this.buildAgentSessionContext(conversationId),
      getProviderNameForSession: (sessionId) => this.getProviderNameForSession(sessionId),
      patchRequestContext,
      recordProactiveRootMessage: ({ conversationId, rootMessageId, prompt, openId }) => {
        const bound = this.historyStore.setConversationFirstMessageId(conversationId, rootMessageId);
        if (!bound) {
          this.logger.warn(`主动任务根消息绑定 conversation first_message_id 失败: conversation=${conversationId}, messageId=${rootMessageId}`);
        }
        this.recordProactiveMessageAfterSend(rootMessageId, `[主动任务] ${prompt}`, openId);
      },
      saveAgentSessionId: (conversationId, sessionId) => {
        this.historyStore.updateAgentSessionId(conversationId, sessionId);
      },
      rememberRestoredSession: (sessionId) => {
        this.restoredSessions.add(sessionId);
      },
      saveResumeId: (conversationId, resumeId) => {
        this.historyStore.updateResumeId(conversationId, resumeId);
      },
      saveAgentEvents: (conversationId, provider, events) => {
        this.historyStore.saveAgentEvents(conversationId, provider, events);
      },
      logger: this.logger,
    });
  }

  // ─── 斜杠命令 ───

  private createSlashCommandRuntime(): SlashCommandRuntime {
    return {
      getThreadInfo: (ctx) => this.getThreadInfoForSlashCommand(ctx),
      clearCurrentContext: (ctx) => this.clearCurrentContextForSlashCommand(ctx),
      stopActiveRun: (ctx) => this.stopActiveRunForSlashCommand(ctx),
      getStatus: () => this.getStatusForSlashCommand(),
      getProviderInfo: () => this.getProviderInfo(),
      setAutoFallback: (enabled) => this.setAutoFallback(enabled),
      switchProvider: (name) => this.switchProvider(name),
      getRestartPolicyContext: () => this.getRestartPolicyContextForSlashCommand(),
      recordRestartRejected: (reason, ctx) => this.recordRestartRejectedForSlashCommand(reason, ctx),
      restart: (ctx) => {
        void this.restartFromSlashCommand(ctx);
      },
    };
  }

  private getThreadInfoForSlashCommand(ctx: MessageContext): SlashThreadInfo {
    const conversationId = this.conversationRouter.findConversation(ctx);
    const session = conversationId ? this.historyStore.getSession(conversationId) : null;

    return {
      threadId: ctx.threadId,
      messageId: ctx.messageId,
      conversationId,
      agentProvider: this.agent.name,
      agentSessionId: session?.agent_session_id ?? null,
      creatorOpenId: session?.open_id ?? null,
      lastActiveAt: session?.last_active_at ?? null,
    };
  }

  private clearCurrentContextForSlashCommand(ctx: MessageContext): boolean {
    const conversationId = this.conversationRouter.findConversation(ctx);
    const session = conversationId ? this.historyStore.getSession(conversationId) : null;

    if (!session?.agent_session_id) return false;

    this.agent.deleteSession(session.agent_session_id).catch(err => {
      this.logger.error('删除 Agent 会话失败:', err);
    });
    this.historyStore.clearSessionAgent(session.id);
    this.restoredSessions.delete(session.agent_session_id);
    this.logger.info(`清除 conversation 会话: ${session.id}`);
    return true;
  }

  private stopActiveRunForSlashCommand(ctx: MessageContext): boolean {
    const conversationId = this.conversationRouter.findConversation(ctx);
    if (!conversationId) return false;

    const activeRun = this.activeRuns.get(conversationId);
    if (!activeRun) return false;

    this.cancelActiveRun(activeRun, '⏹ 任务已被用户中断。', 'user_stop_command');
    return true;
  }

  private getStatusForSlashCommand(): SlashRuntimeStatus {
    const status = this.getStatus();
    return {
      agentProvider: status.agentProvider,
      isRunning: status.isRunning,
      sessionCount: status.sessionCount,
      activeRunCount: status.activeCards,
      isDraining: status.isDraining,
    };
  }

  private async restartFromSlashCommand(ctx: MessageContext): Promise<void> {
    const processName = this.getProcessName();
    this.logger.info(`收到 /restart 命令，准备优雅重启 (process: ${processName})`);

    // 立即回复确认（这张回复独立，不进 activeRuns）
    const restartResponder = this.messageGateway.createResponder({ kind: 'reply', parentMessageId: ctx.messageId });
    await restartResponder.complete({
      events: [],
      text: buildRestartStartText(this.activeRuns.size),
    });

    // Step 1: drain — 拒绝新消息，等待活跃任务完成
    this.isDraining = true;
    this.logger.info(`/restart: 进入 drain 模式，活跃任务: ${this.activeRuns.size}`);

    if (this.activeRuns.size > 0) {
      const drainStart = Date.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.activeRuns.size === 0) {
            this.logger.info('/restart: 所有活跃任务已完成');
            resolve();
            return;
          }
          if (Date.now() - drainStart >= DRAIN_TIMEOUT) {
            this.logger.warn(`/restart: drain 超时，剩余 ${this.activeRuns.size} 个任务`);
            resolve();
            return;
          }
          setTimeout(check, 500);
        };
        check();
      });
    }

    // Step 2: 给残留响应发 shutdown 状态，然后清空追踪
    if (this.activeRuns.size > 0) {
      await Promise.allSettled(
        Array.from(this.activeRuns.values()).map(activeRun =>
          activeRun.responder.close(RESTART_INTERRUPTED_TEXT).catch(() => {})
        )
      );
      this.activeRuns.clear();
    }

    // Step 3: 更新重启确认卡片为完成状态
    await restartResponder.complete({ events: [], text: RESTART_COMPLETE_TEXT }).catch(() => {});

    // Step 4: 走 package script 重启，确保手动命令和聊天命令使用同一入口
    const restartCommand = getRestartExecutorCommand(processName);
    this.logger.info(`/restart: drain 完成，执行 ${restartCommand}`);
    try {
      // 等待 drain 完成后再 restart，避免 pm2 kill 时 activeRuns 还未清空
      this.restartExecutor(restartCommand);
    } catch {
      // restart 会杀自己，这里大概率不会执行到
    }
  }

  private getProcessName(): string {
    return process.env.name || appConfig.processName || 'sage';
  }

  private getRestartPolicyContextForSlashCommand(): {
    ownerOpenId?: string;
    isDevProcess: boolean;
  } {
    const processName = this.getProcessName();
    return {
      ownerOpenId: process.env.OWNER_OPEN_ID?.trim() || undefined,
      isDevProcess: this.isDevRestartProcess(processName),
    };
  }

  private isDevRestartProcess(processName: string): boolean {
    return processName === 'sage-dev' || process.env.SAGE_INSTANCE === 'sage-dev';
  }

  private recordRestartRejectedForSlashCommand(reason: SlashRestartRejectReason, ctx: MessageContext): void {
    if (reason === 'non-owner') {
      this.logger.warn(`/restart 被拒绝: open=${ctx.openId}, owner configured`);
      return;
    }
    if (reason === 'dev-non-p2p') {
      this.logger.warn(`/restart 被拒绝: OWNER_OPEN_ID 未配置，dev 仅允许私聊重启`);
      return;
    }
    this.logger.warn('/restart 被拒绝: 生产环境未配置 OWNER_OPEN_ID');
  }

  // ─── 会话管理 ───

  private async handleMessageRecall(messageId: string): Promise<void> {
    const removedPending = this.removePendingMessage(messageId);
    const activeRun = this.findActiveRunBySourceMessage(messageId);

    if (activeRun) {
      this.cancelActiveRun(
        activeRun,
        '⏹ 已因用户撤回原消息而取消。',
        `message_recalled:${messageId}`,
      );
    }

    this.conversationRouter.forgetMessageConversation(messageId);

    if (!removedPending && !activeRun) {
      this.logger.info(`撤回消息未命中待处理或运行中任务: messageId=${messageId}`);
    }
  }

  private removePendingMessage(messageId: string): boolean {
    let removed = false;

    for (const [conversationId, queue] of this.pendingMessages) {
      const nextQueue = queue.filter(ctx => ctx.messageId !== messageId);
      if (nextQueue.length === queue.length) continue;

      removed = true;
      if (nextQueue.length === 0) {
        this.pendingMessages.delete(conversationId);
      } else {
        this.pendingMessages.set(conversationId, nextQueue);
      }

      this.logger.info(
        `撤回排队消息: conv=${conversationId}, msg=${messageId}, removed=${queue.length - nextQueue.length}, remaining=${nextQueue.length}`,
      );
    }

    return removed;
  }

  private findActiveRunBySourceMessage(messageId: string): ActiveRun | undefined {
    for (const activeRun of this.activeRuns.values()) {
      if (activeRun.sourceMessageIds.has(messageId)) {
        return activeRun;
      }
    }
    return undefined;
  }

  private cancelActiveRun(activeRun: ActiveRun, reason: string, source: string): void {
    activeRun.cancelReason = reason;
    if (!activeRun.abortController.signal.aborted) {
      activeRun.abortController.abort();
      this.logger.info(
        `取消运行中任务: conv=${activeRun.conversationId}, source=${source}, sourceMessages=${Array.from(activeRun.sourceMessageIds).join(',')}`,
      );
    }
  }

  private normalizeProactiveTopic(title?: string): string {
    const topic = (title || DEFAULT_PROACTIVE_TOPIC).replace(/\s+/g, ' ').trim() || DEFAULT_PROACTIVE_TOPIC;
    return topic.length > 80 ? `${topic.slice(0, 77)}...` : topic;
  }

  private async getOrCreateAgentSession(conversationId: string): Promise<{ sessionId: string; isNew: boolean }> {
    const row = this.historyStore.getSession(conversationId);
    const sessionContext = this.buildAgentSessionContext(conversationId);

    if (row?.agent_session_id) {
      if (!this.restoredSessions.has(row.agent_session_id)) {
        try {
          await this.agent.restoreSession(row.agent_session_id, row.resume_id || undefined, sessionContext);
          this.restoredSessions.add(row.agent_session_id);
          this.logger.info(`懒恢复会话: ${conversationId} -> ${row.agent_session_id}`);
        } catch (err) {
          this.logger.warn(`恢复会话失败，将创建新会话: ${row.agent_session_id}`, err);
          const sessionId = await this.createNewAgentSession(conversationId);
          return { sessionId, isNew: true };
        }
      } else {
        await this.agent.updateSessionContext?.(row.agent_session_id, sessionContext);
        this.logger.info(`复用 conversation 会话: ${conversationId} -> ${row.agent_session_id}`);
      }
      return { sessionId: row.agent_session_id, isNew: false };
    }

    const sessionId = await this.createNewAgentSession(conversationId);
    return { sessionId, isNew: true };
  }

  private async createNewAgentSession(conversationId: string): Promise<string> {
    const session = await this.agent.createSession(this.buildAgentSessionContext(conversationId));
    this.restoredSessions.add(session.id);
    this.historyStore.updateAgentSessionId(conversationId, session.id);
    this.logger.info(`创建新 agent 会话: ${conversationId} -> ${session.id} (provider: ${this.agent.name})`);
    return session.id;
  }

  private buildAgentSessionContext(conversationId: string): {
    conversationId: string;
    threadId?: string;
    openId?: string;
    chatId?: string;
    chatType?: string;
  } {
    const row = this.historyStore.getSession(conversationId);
    return {
      conversationId,
      threadId: row?.thread_id ?? undefined,
      openId: row?.open_id ?? undefined,
      chatId: row?.chat_id ?? undefined,
      chatType: row?.chat_type ?? undefined,
    };
  }

  private getProviderNameForSession(sessionId: string): string {
    if (!(this.agent instanceof FallbackAgentProvider)) return this.agent.name;
    if (sessionId.startsWith('cdx-')) return 'codex';
    if (sessionId.startsWith('ccm-')) return 'cc-minimax';
    if (sessionId.startsWith('cc-')) return 'claude-code';
    if (sessionId.startsWith('oc-')) return 'opencode';
    return this.agent.activeProviderName;
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
      this.isDraining = false;
      await this.agent.initialize();
      await this.messageGateway.start();
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
      this.clearCleanupTask();
      this.logger.warn('服务未在运行');
      return;
    }

    try {
      this.logger.info('正在停止 Sage...');
      this.clearCleanupTask();

      // Step 1: 进入 drain 模式，拒绝新消息
      this.isDraining = true;
      this.logger.info(`进入 drain 模式，当前活跃任务: ${this.activeRuns.size}`);

      // Step 2: 等待活跃任务完成（超时强制退出）
      if (this.activeRuns.size > 0) {
        const drainStart = Date.now();
        await new Promise<void>((resolve) => {
          const check = () => {
            if (this.activeRuns.size === 0) {
              this.logger.info('所有活跃任务已完成');
              resolve();
              return;
            }
            if (Date.now() - drainStart >= DRAIN_TIMEOUT) {
              this.logger.warn(`drain 超时 (${DRAIN_TIMEOUT}ms)，剩余 ${this.activeRuns.size} 个活跃任务`);
              resolve();
              return;
            }
            setTimeout(check, 500);
          };
          check();
        });
      }

      // Step 3: 给仍在活跃的响应发 shutdown 状态
      if (this.activeRuns.size > 0) {
        this.logger.info(`正在关闭 ${this.activeRuns.size} 个残留响应...`);
        const closePromises = Array.from(this.activeRuns.values()).map(activeRun =>
          activeRun.responder.close('⚠️ 服务正在重启，当前对话已中断。请重新发送消息继续。').catch(err => {
            this.logger.warn(`shutdown 响应关闭失败: ${activeRun.conversationId}`, err);
          })
        );
        await Promise.allSettled(closePromises);
        this.activeRuns.clear();
      }

      // Step 4: 停止服务
      await this.messageGateway.stop();
      await this.agent.destroy();
      this.isRunning = false;
      this.isDraining = false;
      this.logger.info('Sage 已停止');
    } catch (error) {
      this.logger.error('停止服务失败:', error);
    }
  }

  private setupCleanupTask(): void {
    const cleanupInterval = 6 * 60 * 60 * 1000;

    this.clearCleanupTask();
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.agent.cleanupSessions(MAX_SESSION_AGE);
        this.restoredSessions.clear();
        this.historyStore.cleanupProcessedEvents();
      } catch (error) {
        this.logger.error('清理过期会话失败:', error);
      }
    }, cleanupInterval);

    this.logger.info('已设置会话清理任务');
  }

  private clearCleanupTask(): void {
    if (!this.cleanupTimer) return;
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  getStatus(): {
    isRunning: boolean;
    agentProvider: string;
    sessionCount: number;
    activeCards: number;
    isDraining: boolean;
  } {
    return {
      isRunning: this.isRunning,
      agentProvider: this.agent.name,
      sessionCount: this.agent.getActiveSessions().length,
      activeCards: this.activeRuns.size,
      isDraining: this.isDraining,
    };
  }

  /** 获取 provider 管理信息（仅 FallbackAgentProvider 时有效） */
  getProviderInfo(): {
    activeProvider: string;
    availableProviders: string[];
    autoFallbackEnabled: boolean;
    isFallback: boolean;
  } {
    if (this.agent instanceof FallbackAgentProvider) {
      return {
        activeProvider: this.agent.activeProviderName,
        availableProviders: this.agent.availableProviders,
        autoFallbackEnabled: this.agent.autoFallbackEnabled,
        isFallback: true,
      };
    }
    return {
      activeProvider: this.agent.name,
      availableProviders: [this.agent.name],
      autoFallbackEnabled: false,
      isFallback: false,
    };
  }

  /** 切换活跃 provider */
  switchProvider(name: string): boolean {
    if (this.agent instanceof FallbackAgentProvider) {
      return this.agent.switchActiveProvider(name);
    }
    return false;
  }

  /** 设置自动降级开关 */
  setAutoFallback(enabled: boolean): void {
    if (this.agent instanceof FallbackAgentProvider) {
      this.agent.setAutoFallback(enabled);
    }
  }

  async cleanupSessions(): Promise<number> {
    const maxAge = MAX_SESSION_AGE;
    const cleaned = await this.agent.cleanupSessions(maxAge);
    this.restoredSessions.clear();
    return cleaned;
  }

  /** 通过 open_id 向用户主动发消息，记录 session 供后续回复延续 */
  async sendProactiveMessage(openId: string, text: string): Promise<string> {
    const messageId = await this.messageGateway.sendProactiveText(openId, text);
    if (messageId) {
      this.recordProactiveMessageAfterSend(messageId, text, openId);
    }
    return messageId;
  }

  private recordProactiveMessageAfterSend(messageId: string, content: string, openId: string): void {
    try {
      this.historyStore.saveProactiveMessage(messageId, content, openId);
      this.logger.info(`主动消息已记录: messageId=${messageId}`);
    } catch (err) {
      this.logger.warn(`主动消息已发送但记录失败，避免重试重复发送: messageId=${messageId}`, err);
    }
  }

  /**
   * 主动触发一次 agent 任务，结果以流式卡片形式发送给 owner。
   * 默认创建独立 session；传 reuseConversationId 时复用原 conversation/session。
   * 用于调度器的 agent 类型任务（例如"每天早上帮我汇总 xxx"）。
   */
  async runAgentForOwner(prompt: string, openId: string, title?: string, options?: RunAgentForOwnerOptions): Promise<void> {
    if (options?.reuseConversationId) {
      const reused = await this.runAgentInExistingConversation(prompt, options.reuseConversationId);
      if (reused) return;
    }

    const conversationId = this.historyStore.createConversation(this.agent.name, {
      openId,
      chatId: '',
      chatType: 'p2p',
    });
    const session = await this.agent.createSession(this.buildAgentSessionContext(conversationId));
    this.restoredSessions.add(session.id);
    this.historyStore.updateAgentSessionId(conversationId, session.id);
    this.registerFallbackSessionConversation(session.id, conversationId);
    patchRequestContext({
      conversationId,
      sessionId: session.id,
      provider: this.getProviderNameForSession(session.id),
    });

    this.historyStore.saveUserMessage(conversationId, this.agent.name, prompt, {
      openId,
      chatId: '',
      chatType: 'p2p',
      agentSessionId: session.id,
    });

    const result = await this.runAgentTurn({
      prompt,
      conversationId,
      sessionId: session.id,
      anchor: { kind: 'proactive', openId, topic: this.normalizeProactiveTopic(title ?? prompt) },
    });

    if (result?.replyMessageId) {
      this.conversationRouter.rememberMessageConversation(result.replyMessageId, conversationId);
      this.logger.info(`主动 agent 任务已发送: messageId=${result.replyMessageId}, session=${session.id}`);
    }
    if (result.status === 'failed') {
      throw result.error ?? new Error('主动 agent 任务失败');
    }
  }

  private async runAgentInExistingConversation(prompt: string, conversationId: string): Promise<boolean> {
    const row = this.historyStore.getSession(conversationId);
    if (!row) {
      this.logger.warn(`定时 agent 复用 conversation 失败，记录不存在: conversation=${conversationId}`);
      return false;
    }
    if (!row.first_message_id) {
      this.logger.warn(`定时 agent 复用 conversation 失败，缺少 first_message_id: conversation=${conversationId}`);
      return false;
    }

    const { sessionId } = await this.getOrCreateAgentSession(conversationId);
    this.registerFallbackSessionConversation(sessionId, conversationId);
    patchRequestContext({
      conversationId,
      sessionId,
      provider: this.getProviderNameForSession(sessionId),
    });

    const scheduledPrompt = `[定时任务触发]\n\n${prompt}`;
    this.historyStore.saveUserMessage(conversationId, this.agent.name, scheduledPrompt, {
      openId: row.open_id ?? undefined,
      chatId: row.chat_id ?? undefined,
      chatType: row.chat_type ?? undefined,
      agentSessionId: sessionId,
    });

    const result = await this.runAgentTurn({
      prompt: scheduledPrompt,
      conversationId,
      sessionId,
      sourceMessageIds: [],
      anchor: { kind: 'reply', parentMessageId: row.first_message_id },
    });

    if (result?.replyMessageId) {
      this.conversationRouter.rememberMessageConversation(result.replyMessageId, conversationId);
      this.logger.info(`定时 agent 任务已复用 conversation: conversation=${conversationId}, session=${sessionId}, messageId=${result.replyMessageId}`);
    }
    if (result.status === 'failed') {
      throw result.error ?? new Error('定时 agent 任务失败');
    }
    return true;
  }

  private registerFallbackSessionConversation(sessionId: string, conversationId: string): void {
    if (this.agent instanceof FallbackAgentProvider) {
      this.agent.registerSessionConversation(sessionId, conversationId);
    }
  }
}
