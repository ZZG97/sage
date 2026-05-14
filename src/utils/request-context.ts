import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type RequestSource = 'http' | 'feishu' | 'scheduler' | 'manual';

export interface RequestContext {
  requestId: string;
  source: RequestSource;
  conversationId?: string;
  messageId?: string;
  sessionId?: string;
  provider?: string;
  taskId?: string;
  runId?: string;
  kind?: string;
  method?: string;
  path?: string;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function createRequestId(prefix = 'req'): string {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

export function normalizeRequestId(value: string | undefined | null): string | null {
  const id = value?.trim();
  if (!id || !SAFE_REQUEST_ID.test(id)) return null;
  return id;
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStorage.run({ ...ctx }, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function patchRequestContext(partial: Partial<RequestContext>): void {
  const ctx = requestContextStorage.getStore();
  if (!ctx) return;

  const { requestId, source, ...rest } = partial;
  Object.assign(ctx, rest);
  if (!ctx.requestId && requestId) ctx.requestId = requestId;
  if (!ctx.source && source) ctx.source = source;
}

export function formatRequestContext(): string {
  const ctx = getRequestContext();
  if (!ctx) return '';

  const fields: Array<[string, string | undefined]> = [
    ['rid', ctx.requestId],
    ['src', ctx.source],
    ['conv', ctx.conversationId],
    ['msg', ctx.messageId],
    ['sid', ctx.sessionId],
    ['provider', ctx.provider],
    ['task', ctx.taskId],
    ['run', ctx.runId],
    ['kind', ctx.kind],
    ['method', ctx.method],
    ['path', ctx.path],
  ];

  return fields
    .filter(([, value]) => value)
    .map(([key, value]) => `[${key}=${value}]`)
    .join(' ');
}
