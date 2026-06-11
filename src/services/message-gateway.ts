import type { AgentEvent } from '../agent/types';
import type { MessageContext } from '../types';

export type IncomingMessageHandler = (ctx: MessageContext) => Promise<void>;
export type MessageRecallHandler = (messageId: string) => Promise<void> | void;

export type ResponseAnchor =
  | { kind: 'reply'; parentMessageId: string }
  | { kind: 'proactive'; openId: string; topic: string };

export interface ResponseBinding {
  rootMessageId?: string;
  messageId?: string;
  messageIds?: string[];
  threadId?: string;
}

export interface AssistantResponseSnapshot {
  events: AgentEvent[];
}

export interface AssistantResponseResult extends AssistantResponseSnapshot {
  text: string;
}

export interface AssistantResponder {
  start(): Promise<ResponseBinding>;
  update(snapshot: AssistantResponseSnapshot): Promise<ResponseBinding | void>;
  complete(result: AssistantResponseResult): Promise<ResponseBinding>;
  fail(message: string): Promise<ResponseBinding | void>;
  close(reason: string): Promise<void>;
}

export interface MessageGateway {
  setMessageHandler(handler: IncomingMessageHandler): void;
  setMessageRecallHandler(handler: MessageRecallHandler): void;
  setDedupFn(fn: (eventId: string) => boolean): void;

  createResponder(anchor: ResponseAnchor): AssistantResponder;
  sendProactiveText(openId: string, text: string): Promise<string>;

  start(): Promise<void>;
  stop(): Promise<void>;
}
