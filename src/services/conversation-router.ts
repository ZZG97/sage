import type { MessageContext } from '../types';
import type { ResponseBinding } from './message-gateway';

export interface ConversationIdentity {
  id: string;
  thread_id: string | null;
}

export interface ConversationRouterStore {
  createConversation(provider: string, ctx?: {
    firstMessageId?: string;
    threadId?: string;
    openId?: string;
    chatId?: string;
    chatType?: MessageContext['chatType'];
  }): string;
  getSessionByThreadId(threadId: string): ConversationIdentity | null;
  getSessionByFirstMessageId(messageId: string): ConversationIdentity | null;
  setConversationThreadId(conversationId: string, threadId: string): void;
}

export interface ConversationRouterLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export class ConversationRouter {
  private readonly messageConversations = new Map<string, string>();
  private readonly threadConversations = new Map<string, string>();

  constructor(
    private readonly store: ConversationRouterStore,
    private readonly logger: ConversationRouterLogger,
  ) {}

  rememberMessageConversation(messageId: string | undefined, conversationId: string): void {
    if (messageId) this.messageConversations.set(messageId, conversationId);
  }

  rememberThreadConversation(threadId: string | undefined, conversationId: string): void {
    if (threadId) this.threadConversations.set(threadId, conversationId);
  }

  forgetMessageConversation(messageId: string): void {
    this.messageConversations.delete(messageId);
  }

  bindResponseToConversation(binding: ResponseBinding | void, conversationId: string): void {
    if (!binding) return;

    this.rememberMessageConversation(binding.rootMessageId, conversationId);
    this.rememberMessageConversation(binding.messageId, conversationId);
    for (const messageId of binding.messageIds ?? []) {
      this.rememberMessageConversation(messageId, conversationId);
    }

    if (!binding.threadId) return;

    const existing = this.store.getSessionByThreadId(binding.threadId);
    if (existing?.id === conversationId) {
      this.rememberThreadConversation(binding.threadId, conversationId);
      return;
    }
    if (existing && existing.id !== conversationId) {
      this.logger.warn(`thread_id 已绑定到其他 conversation: threadId=${binding.threadId}, existing=${existing.id}, current=${conversationId}`);
      return;
    }

    this.store.setConversationThreadId(conversationId, binding.threadId);
    this.rememberThreadConversation(binding.threadId, conversationId);
    this.logger.info(`conversation 绑定 thread_id: conversation=${conversationId}, threadId=${binding.threadId}`);
  }

  getOrCreateConversation(ctx: MessageContext, providerName: string): string {
    if (ctx.threadId) {
      const cached = this.threadConversations.get(ctx.threadId);
      if (cached) {
        this.bindIncomingConversation(ctx, cached);
        return cached;
      }

      const existing = this.store.getSessionByThreadId(ctx.threadId);
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

      const existingByRoot = this.store.getSessionByFirstMessageId(rootMessageId);
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

    const existingByMessage = this.store.getSessionByFirstMessageId(ctx.messageId);
    if (existingByMessage) {
      this.bindIncomingConversation(ctx, existingByMessage.id);
      this.rememberThreadConversation(existingByMessage.thread_id ?? undefined, existingByMessage.id);
      return existingByMessage.id;
    }

    const firstMessageId = rootMessageId ?? ctx.messageId;
    const conversationId = this.store.createConversation(providerName, {
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

  findConversation(ctx: MessageContext): string | null {
    if (ctx.threadId) {
      const cached = this.threadConversations.get(ctx.threadId);
      if (cached) {
        this.bindIncomingConversation(ctx, cached);
        return cached;
      }
      const byThread = this.store.getSessionByThreadId(ctx.threadId);
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

      const byRoot = this.store.getSessionByFirstMessageId(rootMessageId);
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
    const byMessage = this.store.getSessionByFirstMessageId(ctx.messageId);
    if (byMessage) {
      this.bindIncomingConversation(ctx, byMessage.id);
      return byMessage.id;
    }
    return null;
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
    const existing = this.store.getSessionByThreadId(ctx.threadId);
    if (!existing) {
      this.store.setConversationThreadId(conversationId, ctx.threadId);
    } else if (existing.id !== conversationId) {
      this.logger.warn(`thread_id 已绑定到其他 conversation: threadId=${ctx.threadId}, existing=${existing.id}, current=${conversationId}`);
    }
  }
}
