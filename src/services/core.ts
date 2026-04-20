import { FeishuService, CARD_SIZE_LIMIT, splitMarkdownByTables } from './feishu';
import { AgentProvider } from '../agent';
import { FallbackAgentProvider } from '../agent/fallback-provider';
import type { AgentEvent } from '../agent/types';
import type { HistoryStore } from './history-store';
import { Logger, AppError } from '../utils';
import { appConfig } from '../config';
import { MessageContext } from '../types';
import { execSync } from 'child_process';

// ─── 常量 ───
const DRAIN_TIMEOUT = 30_000; // drain 最多等 30s
const MAX_SESSION_AGE = 24 * 60 * 60 * 1000; // 会话最大存活时间 24h
const DEFAULT_PROACTIVE_TOPIC = 'Sage 主动任务';

export class SageCore {
  private feishuService: FeishuService;
  private agent: AgentProvider;
  private historyStore: HistoryStore;
  private logger: Logger;
  private isRunning: boolean = false;
  private isDraining: boolean = false;

  // 活跃卡片追踪：replyMessageId -> { conversationId, startTime, abortController }
  private activeCards: Map<string, { conversationId: string; startTime: number; abortController: AbortController }> = new Map();

  // 已在 provider 中恢复过的 session（避免重复 restoreSession）
  private restoredSessions: Set<string> = new Set();

  // 运行期飞书标识到内部 conversation 的查找缓存。
  private messageConversations: Map<string, string> = new Map();
  private threadConversations: Map<string, string> = new Map();

  // per-conversation 消息排队：正在处理的 conversation + 排队中的消息
  private processingConversations: Set<string> = new Set();
  private pendingMessages: Map<string, MessageContext[]> = new Map();

  constructor(agent: AgentProvider, historyStore: HistoryStore) {
    this.logger = new Logger('SageCore');
    this.agent = agent;
    this.historyStore = historyStore;
    this.feishuService = new FeishuService(appConfig.feishu);

    // 设置飞书消息处理器（不再返回 string，SageCore 自行控制卡片）
    this.feishuService.setMessageHandler(this.handleFeishuMessage.bind(this));

    // 为 FallbackAgentProvider 注入历史查询能力
    if (agent instanceof FallbackAgentProvider) {
      agent.setRecentHistoryFn((conversationId, maxTurns) =>
        this.historyStore.getRecentConversation(conversationId, maxTurns)
      );
    }

    // 注入 DB 去重（重启后兜底）
    this.feishuService.setDedupFn((eventId) => this.historyStore.isDuplicateEvent(eventId));

    // 回复后飞书创建 thread 时，给 conversation 补上 thread_id。
    // message_id 和 thread_id 是飞书的两个外部标识，内部状态只挂 conversationId。
    this.feishuService.setThreadCreatedHandler((messageId, threadId) => {
      const conversationId =
        this.messageConversations.get(messageId)
        ?? this.historyStore.getSessionByFirstMessageId(messageId)?.id
        ?? this.historyStore.getSessionByThreadId(threadId)?.id;

      if (!conversationId) {
        this.logger.warn(`收到 thread_id 但未找到 conversation: messageId=${messageId}, threadId=${threadId}`);
        return;
      }

      const existing = this.historyStore.getSessionByThreadId(threadId);
      if (existing && existing.id !== conversationId) {
        this.logger.warn(`thread_id 已绑定到其他 conversation: threadId=${threadId}, existing=${existing.id}, current=${conversationId}`);
        return;
      }

      this.historyStore.setConversationThreadId(conversationId, threadId);
      this.messageConversations.set(messageId, conversationId);
      this.threadConversations.set(threadId, conversationId);
      this.logger.info(`conversation 绑定 thread_id: conversation=${conversationId}, parentMessage=${messageId}, threadId=${threadId}`);
    });
  }

  // 处理飞书消息（主入口）— 排队 + 流式卡片生命周期
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

    // 斜杠命令不排队，立即处理
    const commandResult = this.handleSlashCommand(ctx);
    if (commandResult === 'async') return;
    if (commandResult !== null) {
      await this.feishuService.replyCard(
        ctx.messageId,
        this.feishuService.buildStreamingCard([], false, commandResult),
      );
      return;
    }

    const conversationId = this.getOrCreateConversation(ctx);

    // 如果该 conversation 正在处理中，排队等待
    if (this.processingConversations.has(conversationId)) {
      const queue = this.pendingMessages.get(conversationId) || [];
      queue.push(ctx);
      this.pendingMessages.set(conversationId, queue);
      this.rememberMessageConversation(ctx.messageId, conversationId);
      this.logger.info(`消息排队: conversation=${conversationId}, 队列长度=${queue.length}, text="${ctx.text.slice(0, 50)}"`);
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

        this.logger.info(`消费排队消息: conversation=${conversationId}, 合并${queuedMessages.length}条`);

        // 构造合并后的 ctx 用于处理
        const mergedCtx: MessageContext = { ...lastCtx, text: hint + mergedText };
        await this.processThreadMessage(mergedCtx, conversationId);
      }
    } finally {
      this.processingConversations.delete(conversationId);
    }
  }

  // 实际处理单条（或合并后的）消息
  private async processThreadMessage(ctx: MessageContext, conversationId: string): Promise<void> {
    try {
      this.rememberMessageConversation(ctx.messageId, conversationId);
      this.logger.info(`处理消息: conversation=${conversationId}, openId=${ctx.openId}, threadId=${ctx.threadId || '无'}, text="${ctx.text.slice(0, 100)}"`);

      // 预处理消息
      let processedMessage = this.preprocessMessage(ctx.text);

      // 获取或创建 Thread 对应的会话
      const { sessionId, isNew } = await this.getOrCreateAgentSession(conversationId);

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

      await this.runAgentToCard({
        prompt: processedMessage,
        conversationId,
        sessionId,
        anchor: { kind: 'reply', parentMessageId: ctx.messageId },
      });

    } catch (error) {
      this.logger.error('处理消息失败:', error);

      if (error instanceof AppError) {
        try {
          await this.feishuService.replyCard(
            ctx.messageId,
            this.feishuService.buildErrorCard(`抱歉，处理消息时出现错误: ${error.message}`),
          );
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * 跑 agent 并渲染成流式卡片。通用能力，既服务于用户消息回复，
   * 也服务于调度器主动触发的 agent 任务。
   *
   * 调用方负责：resolve conversationId、创建/恢复 session、保存用户消息（如适用）。
   * 本方法负责：发初始卡片 → 流式消费 agent → 节流 PATCH → 超限拆卡
   *          → 最终卡片 → 持久化 session/resume_id/events → activeCards 清理。
   */
  private async runAgentToCard(opts: {
    prompt: string;
    conversationId: string;
    sessionId: string;
    anchor:
      | { kind: 'reply'; parentMessageId: string }
      | { kind: 'proactive'; openId: string; title?: string };
  }): Promise<{ replyMessageId: string } | null> {
    const { prompt, conversationId, sessionId, anchor } = opts;

    // Step 1: 发送初始 "thinking" 卡片
    const initialCard = this.feishuService.buildStreamingCard([], true);
    let replyMessageId = '';
    if (anchor.kind === 'reply') {
      this.rememberMessageConversation(anchor.parentMessageId, conversationId);
      const r = await this.feishuService.replyCard(anchor.parentMessageId, initialCard);
      replyMessageId = r.messageId;
    } else {
      const topic = this.normalizeProactiveTopic(anchor.title ?? prompt);
      const rootMessageId = await this.feishuService.sendTextToUser(anchor.openId, topic);
      if (!rootMessageId) {
        this.logger.error('发送主动任务根消息失败，无 messageId');
        return null;
      }

      this.rememberMessageConversation(rootMessageId, conversationId);
      const bound = this.historyStore.setConversationFirstMessageId(conversationId, rootMessageId);
      if (!bound) {
        this.logger.warn(`主动任务根消息绑定 conversation first_message_id 失败: conversation=${conversationId}, messageId=${rootMessageId}`);
      }
      this.recordProactiveMessageAfterSend(rootMessageId, `[主动任务] ${prompt}`, anchor.openId);

      const r = await this.feishuService.replyCard(rootMessageId, initialCard);
      replyMessageId = r.messageId;
    }

    if (!replyMessageId) {
      this.logger.error('发送初始卡片失败，无 messageId');
      return null;
    }

    // 追踪活跃卡片（含 abort 控制器）
    const abortController = new AbortController();
    this.rememberMessageConversation(replyMessageId, conversationId);
    this.activeCards.set(replyMessageId, { conversationId, startTime: Date.now(), abortController });

    // Step 2: 流式处理 agent 消息（含卡片大小保护）
    const allEvents: AgentEvent[] = [];
    let displayEvents: AgentEvent[] = []; // 当前卡片展示的事件
    let resultText = '';
    let newSessionId: string | undefined;
    let lastPatchTime = 0;
    let currentReplyMessageId = replyMessageId;
    const PATCH_INTERVAL = 1500;

    try {
      // 用 Promise.race 实现可中断的流式消费：abort 信号能立即打断等待中的 next()
      const stream = this.agent.sendMessageStream(sessionId, prompt, abortController.signal);
      const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
        abortController.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
      });

      while (true) {
        const iterResult = await Promise.race([stream.next(), abortPromise]);
        if (iterResult.done) {
          if (abortController.signal.aborted) {
            this.logger.info(`任务被用户中断: ${conversationId}`);
            resultText = '⏹ 任务已被用户中断。';
            stream.return?.(undefined as any).catch(() => {});
          }
          break;
        }
        const event = iterResult.value;

        allEvents.push(event);
        displayEvents.push(event);

        if ((event as any).metadata?.newSessionId) {
          newSessionId = (event as any).metadata.newSessionId;
        }

        if (event.type === 'result') {
          resultText = event.content || '';
          continue;
        }

        // 节流 PATCH
        if (event.type === 'tool_call' || event.type === 'thinking' || event.type === 'text' || event.type === 'notice') {
          const now = Date.now();
          if (now - lastPatchTime >= PATCH_INTERVAL) {
            const card = this.feishuService.buildStreamingCard(displayEvents, true);

            const stepsOnlyEvents = displayEvents.filter(e => e.type !== 'text');
            const stepsCard = this.feishuService.buildStreamingCard(stepsOnlyEvents, true);
            const stepsSize = Buffer.byteLength(stepsCard, 'utf-8');

            if (stepsSize > CARD_SIZE_LIMIT) {
              const closingCard = this.feishuService.buildStreamingCard(
                displayEvents.slice(0, -1), false, '↓ 内容较长，后续内容见下方卡片',
              );
              await this.feishuService.patchCard(currentReplyMessageId, closingCard).catch(() => {});
              this.activeCards.delete(currentReplyMessageId);

              displayEvents = [event];
              const newCard = this.feishuService.buildStreamingCard(displayEvents, true);
              const { messageId: newMsgId } = await this.feishuService.replyCard(currentReplyMessageId, newCard);
              if (newMsgId) {
                currentReplyMessageId = newMsgId;
                this.rememberMessageConversation(currentReplyMessageId, conversationId);
                this.activeCards.set(currentReplyMessageId, { conversationId, startTime: Date.now(), abortController });
              }
              this.logger.info(`steps 超限 (${stepsSize}B)，已开新卡: ${currentReplyMessageId}`);
            } else {
              const patchOk = await this.feishuService.patchCard(currentReplyMessageId, card);
              if (!patchOk) {
                this.activeCards.delete(currentReplyMessageId);
                displayEvents = [event];
                const newCard = this.feishuService.buildStreamingCard(displayEvents, true);
                const { messageId: newMsgId } = await this.feishuService.replyCard(currentReplyMessageId, newCard);
                if (newMsgId) {
                  currentReplyMessageId = newMsgId;
                  this.rememberMessageConversation(currentReplyMessageId, conversationId);
                  this.activeCards.set(currentReplyMessageId, { conversationId, startTime: Date.now(), abortController });
                }
                this.logger.warn(`流式 PATCH 失败，已开新卡: ${currentReplyMessageId}`);
              }
            }
            lastPatchTime = now;
          }
        }
      }
    } catch (error: any) {
      this.logger.error('Agent 流式处理异常:', error);
      resultText = resultText || `处理出错: ${error.message}`;
    }

    // Step 3-5 用 try-finally 保护，确保 activeCards 一定被清理
    try {
      // Step 3: 处理 fallback session 迁移
      if (newSessionId) {
        this.historyStore.updateAgentSessionId(conversationId, newSessionId);
        this.restoredSessions.add(newSessionId);
        this.logger.info(`Fallback 更新会话: ${conversationId} -> ${newSessionId}`);
      }

      const effectiveSessionId = newSessionId ?? sessionId;
      const resumeId = this.agent.getResumeId(effectiveSessionId);
      if (resumeId) {
        this.historyStore.updateResumeId(conversationId, resumeId);
      }

      // 记录 agent 事件
      this.historyStore.saveAgentEvents(conversationId, this.agent.name, allEvents);

      // Step 4: 最终卡片更新
      let finalText = resultText;
      try {
        finalText = await this.feishuService.processImagesInMarkdown(finalText);
      } catch (err) {
        this.logger.warn('处理回复中的图片失败:', err);
      }

      const textChunks = splitMarkdownByTables(finalText);
      const firstChunkText = textChunks[0] || finalText;

      const finalCard = this.feishuService.buildStreamingCard(displayEvents, false, firstChunkText);
      const finalCardSize = Buffer.byteLength(finalCard, 'utf-8');

      if (finalCardSize > CARD_SIZE_LIMIT) {
        this.logger.info(`最终卡片超限 (${finalCardSize}B)，steps 留当前卡，文本开新卡 (${textChunks.length} 块)`);
        const stepsCard = this.feishuService.buildStreamingCard(displayEvents, false, '↓ 回复内容见下方卡片');
        await this.feishuService.patchCard(currentReplyMessageId, stepsCard).catch(() => {});

        for (const chunk of textChunks) {
          const chunkCard = this.feishuService.buildStreamingCard([], false, chunk);
          if (Buffer.byteLength(chunkCard, 'utf-8') > CARD_SIZE_LIMIT) {
            this.logger.warn(`文本 chunk 仍超限，降级为纯文本`);
            await this.feishuService.replyText(currentReplyMessageId, chunk);
          } else {
            await this.feishuService.replyCard(currentReplyMessageId, chunkCard);
          }
        }
      } else {
        const patchOk = await this.feishuService.patchCard(currentReplyMessageId, finalCard);
        if (!patchOk) {
          await this.feishuService.replyText(currentReplyMessageId, finalText);
        }

        for (let i = 1; i < textChunks.length; i++) {
          const chunkCard = this.feishuService.buildStreamingCard([], false, textChunks[i]);
          await this.feishuService.replyCard(currentReplyMessageId, chunkCard);
        }
      }

      // Step 5: 发送本地文件附件
      try {
        await this.feishuService.sendLocalFileAttachments(currentReplyMessageId, finalText);
      } catch (err) {
        this.logger.warn('发送文件附件失败:', err);
      }

      this.logger.info(`处理完成，回复长度: ${resultText.length}`);
    } finally {
      // 确保 resume_id 持久化（即使中断也要保存）和 activeCards 清理
      try {
        const effectiveSessionId = newSessionId ?? sessionId;
        const resumeId = this.agent.getResumeId(effectiveSessionId);
        if (resumeId) {
          this.historyStore.updateResumeId(conversationId, resumeId);
        }
      } catch (err) {
        this.logger.warn('持久化 resume_id 失败:', err);
      }
      this.activeCards.delete(currentReplyMessageId);
    }

    return { replyMessageId: currentReplyMessageId };
  }

  // ─── 斜杠命令 ───

  private handleSlashCommand(ctx: MessageContext): string | null | 'async' {
    const text = ctx.text.trim();

    if (text === '/thread_id') return this.cmdThreadId(ctx);
    if (text === '/clear') return this.cmdClear(ctx);
    if (text === '/stop') return this.cmdStop(ctx);
    if (text === '/help') return this.cmdHelp();
    if (text === '/status') return this.cmdStatus();
    if (text.startsWith('/fallback')) return this.cmdFallback(text);
    if (text.startsWith('/provider')) return this.cmdProvider(text);
    if (text === '/restart') {
      this.cmdRestart(ctx);
      return 'async';
    }

    return null;
  }

  private cmdThreadId(ctx: MessageContext): string {
    const conversationId = this.findConversation(ctx);
    const session = conversationId ? this.historyStore.getSession(conversationId) : null;

    if (ctx.threadId) {
      const info = [
        `Thread ID: ${ctx.threadId}`,
        `Conversation ID: ${conversationId || '未创建'}`,
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
    const conversationId = this.findConversation(ctx);
    const session = conversationId ? this.historyStore.getSession(conversationId) : null;

    if (session?.agent_session_id) {
      this.agent.deleteSession(session.agent_session_id).catch(err => {
        this.logger.error('删除 Agent 会话失败:', err);
      });
      this.historyStore.clearSessionAgent(session.id);
      this.restoredSessions.delete(session.agent_session_id);
      this.logger.info(`清除 conversation 会话: ${session.id}`);
      return '已清空当前话题的上下文。下一条消息将开启新的对话。';
    }

    return '当前话题没有活跃的上下文。';
  }

  private cmdStop(ctx: MessageContext): string {
    const conversationId = this.findConversation(ctx);
    if (!conversationId) return '当前话题没有正在执行的任务。';

    // 在 activeCards 中找到该 conversation 的活跃任务
    let aborted = false;
    for (const [msgId, card] of this.activeCards) {
      if (card.conversationId === conversationId) {
        card.abortController.abort();
        aborted = true;
        this.logger.info(`用户中断任务: conversation=${conversationId}, cardMsgId=${msgId}`);
      }
    }

    if (aborted) {
      return '⏹ 已中断当前任务';
    }
    return '当前话题没有正在执行的任务。';
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
      '/stop - 中断当前话题正在执行的任务',
      '/status - 查看服务状态',
      '/fallback [on|off] - 查看/切换自动降级开关',
      '/provider [name] - 查看/切换活跃 provider',
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
    if (this.agent instanceof FallbackAgentProvider) {
      lines.push(`自动降级: ${this.agent.autoFallbackEnabled ? '开启' : '关闭'}`);
      lines.push(`当前活跃: ${this.agent.activeProviderName}`);
    }
    if (this.isDraining) lines.push('⚠️ 服务正在关闭中 (drain)');
    return lines.join('\n');
  }

  private cmdFallback(text: string): string {
    if (!(this.agent instanceof FallbackAgentProvider)) {
      return '当前未配置 fallback provider，无法切换。';
    }

    const arg = text.replace('/fallback', '').trim().toLowerCase();
    if (!arg) {
      return `自动降级: ${this.agent.autoFallbackEnabled ? '✅ 开启' : '❌ 关闭'}\n用法: /fallback on|off`;
    }

    if (arg === 'on') {
      this.agent.setAutoFallback(true);
      return '✅ 自动降级已开启';
    }
    if (arg === 'off') {
      this.agent.setAutoFallback(false);
      return '❌ 自动降级已关闭';
    }

    return `无效参数: ${arg}\n用法: /fallback on|off`;
  }

  private cmdProvider(text: string): string {
    if (!(this.agent instanceof FallbackAgentProvider)) {
      return `当前 provider: ${this.agent.name}\n仅配置了单个 provider，无法切换。`;
    }

    const arg = text.replace('/provider', '').trim();
    if (!arg) {
      const available = this.agent.availableProviders;
      const active = this.agent.activeProviderName;
      const lines = [
        `当前活跃: ${active}`,
        `可用 providers:`,
        ...available.map(p => `  ${p === active ? '→' : ' '} ${p}`),
        '',
        '用法: /provider <name>',
      ];
      return lines.join('\n');
    }

    if (this.agent.switchActiveProvider(arg)) {
      return `✅ 已切换到 ${arg}（新会话生效，已有会话不受影响）`;
    }

    return `未知 provider: ${arg}\n可用: ${this.agent.availableProviders.join(', ')}`;
  }

  // ─── 会话管理 ───

  private rememberMessageConversation(messageId: string | undefined, conversationId: string): void {
    if (messageId) this.messageConversations.set(messageId, conversationId);
  }

  private rememberThreadConversation(threadId: string | undefined, conversationId: string): void {
    if (threadId) this.threadConversations.set(threadId, conversationId);
  }

  private normalizeProactiveTopic(title?: string): string {
    const topic = (title || DEFAULT_PROACTIVE_TOPIC).replace(/\s+/g, ' ').trim() || DEFAULT_PROACTIVE_TOPIC;
    return topic.length > 80 ? `${topic.slice(0, 77)}...` : topic;
  }

  private getReplyRootMessageId(ctx: MessageContext): string | undefined {
    return ctx.rootId ?? ctx.parentId;
  }

  private bindIncomingConversation(ctx: MessageContext, conversationId: string): void {
    this.rememberMessageConversation(ctx.messageId, conversationId);

    const rootMessageId = this.getReplyRootMessageId(ctx);
    this.rememberMessageConversation(rootMessageId, conversationId);

    if (!ctx.threadId) return;

    this.rememberThreadConversation(ctx.threadId, conversationId);
    const existing = this.historyStore.getSessionByThreadId(ctx.threadId);
    if (!existing) {
      this.historyStore.setConversationThreadId(conversationId, ctx.threadId);
    } else if (existing.id !== conversationId) {
      this.logger.warn(`thread_id 已绑定到其他 conversation: threadId=${ctx.threadId}, existing=${existing.id}, current=${conversationId}`);
    }
  }

  private getOrCreateConversation(ctx: MessageContext): string {
    if (ctx.threadId) {
      const cached = this.threadConversations.get(ctx.threadId);
      if (cached) {
        this.bindIncomingConversation(ctx, cached);
        return cached;
      }

      const existing = this.historyStore.getSessionByThreadId(ctx.threadId);
      if (existing) {
        this.bindIncomingConversation(ctx, existing.id);
        return existing.id;
      }
    }

    const rootMessageId = this.getReplyRootMessageId(ctx);
    if (rootMessageId) {
      const cachedByRoot = this.messageConversations.get(rootMessageId);
      if (cachedByRoot) {
        this.bindIncomingConversation(ctx, cachedByRoot);
        return cachedByRoot;
      }

      const existingByRoot = this.historyStore.getSessionByFirstMessageId(rootMessageId);
      if (existingByRoot) {
        this.bindIncomingConversation(ctx, existingByRoot.id);
        return existingByRoot.id;
      }
    }

    const cachedByMessage = this.messageConversations.get(ctx.messageId);
    if (cachedByMessage) {
      this.bindIncomingConversation(ctx, cachedByMessage);
      return cachedByMessage;
    }

    const existingByMessage = this.historyStore.getSessionByFirstMessageId(ctx.messageId);
    if (existingByMessage) {
      this.bindIncomingConversation(ctx, existingByMessage.id);
      this.rememberThreadConversation(existingByMessage.thread_id ?? undefined, existingByMessage.id);
      return existingByMessage.id;
    }

    const firstMessageId = rootMessageId ?? ctx.messageId;
    const conversationId = this.historyStore.createConversation(this.agent.name, {
      firstMessageId,
      threadId: ctx.threadId,
      openId: ctx.openId,
      chatId: ctx.chatId,
      chatType: ctx.chatType,
    });

    this.bindIncomingConversation(ctx, conversationId);
    this.logger.info(`创建 conversation: id=${conversationId}, firstMessage=${firstMessageId}, threadId=${ctx.threadId || '无'}`);
    return conversationId;
  }

  private findConversation(ctx: MessageContext): string | null {
    if (ctx.threadId) {
      const cached = this.threadConversations.get(ctx.threadId);
      if (cached) {
        this.bindIncomingConversation(ctx, cached);
        return cached;
      }
      const byThread = this.historyStore.getSessionByThreadId(ctx.threadId);
      if (byThread) {
        this.bindIncomingConversation(ctx, byThread.id);
        return byThread.id;
      }
    }

    const rootMessageId = this.getReplyRootMessageId(ctx);
    if (rootMessageId) {
      const cachedByRoot = this.messageConversations.get(rootMessageId);
      if (cachedByRoot) {
        this.bindIncomingConversation(ctx, cachedByRoot);
        return cachedByRoot;
      }

      const byRoot = this.historyStore.getSessionByFirstMessageId(rootMessageId);
      if (byRoot) {
        this.bindIncomingConversation(ctx, byRoot.id);
        return byRoot.id;
      }
    }

    const cached = this.messageConversations.get(ctx.messageId);
    if (cached) {
      this.bindIncomingConversation(ctx, cached);
      return cached;
    }
    const byMessage = this.historyStore.getSessionByFirstMessageId(ctx.messageId);
    if (byMessage) {
      this.bindIncomingConversation(ctx, byMessage.id);
      return byMessage.id;
    }
    return null;
  }

  private async getOrCreateAgentSession(conversationId: string): Promise<{ sessionId: string; isNew: boolean }> {
    const row = this.historyStore.getSession(conversationId);

    if (row?.agent_session_id) {
      if (!this.restoredSessions.has(row.agent_session_id)) {
        try {
          await this.agent.restoreSession(row.agent_session_id, row.resume_id || undefined);
          this.restoredSessions.add(row.agent_session_id);
          this.logger.info(`懒恢复会话: ${conversationId} -> ${row.agent_session_id}`);
        } catch (err) {
          this.logger.warn(`恢复会话失败，将创建新会话: ${row.agent_session_id}`, err);
          const sessionId = await this.createNewAgentSession(conversationId);
          return { sessionId, isNew: true };
        }
      } else {
        this.logger.info(`复用 conversation 会话: ${conversationId} -> ${row.agent_session_id}`);
      }
      return { sessionId: row.agent_session_id, isNew: false };
    }

    const sessionId = await this.createNewAgentSession(conversationId);
    return { sessionId, isNew: true };
  }

  private async createNewAgentSession(conversationId: string): Promise<string> {
    const session = await this.agent.createSession();
    this.restoredSessions.add(session.id);
    this.historyStore.updateAgentSessionId(conversationId, session.id);
    this.logger.info(`创建新 agent 会话: ${conversationId} -> ${session.id} (provider: ${this.agent.name})`);
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
        await this.agent.cleanupSessions(MAX_SESSION_AGE);
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
    activeCards: number;
    isDraining: boolean;
  } {
    return {
      isRunning: this.isRunning,
      agentProvider: this.agent.name,
      sessionCount: this.agent.getActiveSessions().length,
      activeCards: this.activeCards.size,
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
    const messageId = await this.feishuService.sendTextToUser(openId, text);
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
   * 每次执行创建独立 session，与现有 thread 不共享上下文。
   * 用于调度器的 agent 类型任务（例如"每天早上帮我汇总 xxx"）。
   */
  async runAgentForOwner(prompt: string, openId: string, title?: string): Promise<void> {
    const session = await this.agent.createSession();
    this.restoredSessions.add(session.id);

    const conversationId = this.historyStore.createConversation(this.agent.name, {
      openId,
      chatId: '',
      chatType: 'p2p',
      agentSessionId: session.id,
    });

    this.historyStore.saveUserMessage(conversationId, this.agent.name, prompt, {
      openId,
      chatId: '',
      chatType: 'p2p',
      agentSessionId: session.id,
    });

    const result = await this.runAgentToCard({
      prompt,
      conversationId,
      sessionId: session.id,
      anchor: { kind: 'proactive', openId, title },
    });

    if (result?.replyMessageId) {
      this.rememberMessageConversation(result.replyMessageId, conversationId);
      this.logger.info(`主动 agent 任务已发送: messageId=${result.replyMessageId}, session=${session.id}`);
    }
  }
}
