import type { AgentEvent } from '../agent/types';
import type { MessageContext } from '../types';
import type {
  AssistantResponder,
  AssistantResponseResult,
  AssistantResponseSnapshot,
  IncomingMessageHandler,
  MessageGateway,
  MessageRecallHandler,
  ResponseAnchor,
  ResponseBinding,
} from './message-gateway';

export type InMemoryOutboundMessage =
  | { type: 'response_start'; messageId: string; parentMessageId?: string; rootMessageId?: string; threadId?: string }
  | { type: 'response_update'; messageId: string; events: AgentEvent[] }
  | { type: 'response_complete'; messageId: string; text: string; events: AgentEvent[] }
  | { type: 'response_fail'; messageId: string; text: string }
  | { type: 'response_close'; messageId: string; reason: string }
  | { type: 'send_text_to_user'; messageId: string; openId: string; text: string };

export class InMemoryMessageGateway implements MessageGateway {
  private messageHandler?: IncomingMessageHandler;
  private messageRecallHandler?: MessageRecallHandler;
  private dedupFn?: (eventId: string) => boolean;
  private nextMessageNumber = 1;
  private nextThreadNumber = 1;
  private readonly messageThreads = new Map<string, string>();
  readonly outboundMessages: InMemoryOutboundMessage[] = [];

  setMessageHandler(handler: IncomingMessageHandler): void {
    this.messageHandler = handler;
  }

  setMessageRecallHandler(handler: MessageRecallHandler): void {
    this.messageRecallHandler = handler;
  }

  setDedupFn(fn: (eventId: string) => boolean): void {
    this.dedupFn = fn;
  }

  createResponder(anchor: ResponseAnchor): AssistantResponder {
    return new InMemoryAssistantResponder(this, anchor);
  }

  async sendProactiveText(openId: string, text: string): Promise<string> {
    const messageId = this.nextMessageId('test_root');
    this.outboundMessages.push({ type: 'send_text_to_user', messageId, openId, text });
    return messageId;
  }

  async emitMessage(ctx: MessageContext): Promise<void> {
    if (!this.messageHandler) throw new Error('message handler is not registered');
    await this.messageHandler(ctx);
  }

  async emitRecall(messageId: string): Promise<void> {
    await this.messageRecallHandler?.(messageId);
  }

  isDuplicateEvent(eventId: string): boolean {
    return this.dedupFn?.(eventId) ?? false;
  }

  async start(): Promise<void> {
    // No external connection needed.
  }

  async stop(): Promise<void> {
    // No external connection needed.
  }

  createReply(anchor: ResponseAnchor): ResponseBinding {
    if (anchor.kind === 'proactive') {
      const rootMessageId = this.nextMessageId('test_root');
      this.outboundMessages.push({
        type: 'send_text_to_user',
        messageId: rootMessageId,
        openId: anchor.openId,
        text: anchor.topic,
      });
      return this.createThreadedReply(rootMessageId, rootMessageId);
    }

    return this.createThreadedReply(anchor.parentMessageId);
  }

  recordUpdate(messageId: string, events: AgentEvent[]): void {
    this.outboundMessages.push({ type: 'response_update', messageId, events: [...events] });
  }

  recordComplete(messageId: string, text: string, events: AgentEvent[]): void {
    this.outboundMessages.push({ type: 'response_complete', messageId, text, events: [...events] });
  }

  recordFail(messageId: string, text: string): void {
    this.outboundMessages.push({ type: 'response_fail', messageId, text });
  }

  recordClose(messageId: string, reason: string): void {
    this.outboundMessages.push({ type: 'response_close', messageId, reason });
  }

  private createThreadedReply(parentMessageId: string, rootMessageId?: string): ResponseBinding {
    const messageId = this.nextMessageId('test_reply');
    const threadId = this.messageThreads.get(parentMessageId) ?? this.nextThreadId();
    this.messageThreads.set(parentMessageId, threadId);
    this.messageThreads.set(messageId, threadId);
    if (rootMessageId) this.messageThreads.set(rootMessageId, threadId);
    this.outboundMessages.push({ type: 'response_start', messageId, parentMessageId, rootMessageId, threadId });
    return { messageId, messageIds: [messageId], rootMessageId, threadId };
  }

  private nextMessageId(prefix: string): string {
    return `${prefix}_${this.nextMessageNumber++}`;
  }

  private nextThreadId(): string {
    return `test_thread_${this.nextThreadNumber++}`;
  }
}

class InMemoryAssistantResponder implements AssistantResponder {
  private binding?: ResponseBinding;

  constructor(
    private readonly gateway: InMemoryMessageGateway,
    private readonly anchor: ResponseAnchor,
  ) {}

  async start(): Promise<ResponseBinding> {
    if (!this.binding) {
      this.binding = this.gateway.createReply(this.anchor);
    }
    return this.binding;
  }

  async update(snapshot: AssistantResponseSnapshot): Promise<ResponseBinding> {
    const binding = await this.start();
    this.gateway.recordUpdate(binding.messageId!, snapshot.events);
    return binding;
  }

  async complete(result: AssistantResponseResult): Promise<ResponseBinding> {
    const binding = await this.start();
    this.gateway.recordComplete(binding.messageId!, result.text, result.events);
    return binding;
  }

  async fail(message: string): Promise<ResponseBinding> {
    const binding = await this.start();
    this.gateway.recordFail(binding.messageId!, message);
    return binding;
  }

  async close(reason: string): Promise<void> {
    if (!this.binding?.messageId) return;
    this.gateway.recordClose(this.binding.messageId, reason);
  }
}
