import type { AgentEvent, AgentProvider, AgentSessionContext } from '../agent/types';
import type { RequestContext } from '../utils';
import { AgentRunIdleTimeoutError, getAgentIdleTimeoutMs, nextAgentStreamEvent } from './agent-run-supervisor';
import type { AssistantResponder, ResponseAnchor, ResponseBinding } from './message-gateway';

const RESPONSE_UPDATE_INTERVAL_MS = 1500;
const DEFAULT_CANCEL_TEXT = '⏹ 任务已被用户中断。';

export interface ActiveRun {
  conversationId: string;
  sourceMessageIds: Set<string>;
  abortController: AbortController;
  responder: AssistantResponder;
  cancelReason?: string;
}

export interface ActiveRunRegistry {
  set(conversationId: string, activeRun: ActiveRun): void;
  deleteIfCurrent(conversationId: string, activeRun: ActiveRun): void;
}

export interface RunAgentTurnResult {
  replyMessageId?: string;
  status: 'success' | 'failed' | 'cancelled';
  error?: Error;
}

interface AgentTurnLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

type RunContextPatch = Pick<Partial<RequestContext>, 'conversationId' | 'sessionId' | 'provider'>;

export interface ExecuteAgentTurnOptions {
  prompt: string;
  conversationId: string;
  sessionId: string;
  sourceMessageIds?: string[];
  anchor: ResponseAnchor;
  agent: Pick<AgentProvider, 'name' | 'sendMessageStream' | 'updateSessionContext' | 'getResumeId'>;
  createResponder(anchor: ResponseAnchor): AssistantResponder;
  activeRuns: ActiveRunRegistry;
  bindResponse(binding: ResponseBinding | void, conversationId: string): void;
  buildAgentSessionContext(conversationId: string): AgentSessionContext;
  getProviderNameForSession(sessionId: string): string;
  patchRequestContext(partial: RunContextPatch): void;
  recordProactiveRootMessage(args: {
    conversationId: string;
    rootMessageId: string;
    prompt: string;
    openId: string;
  }): void;
  saveAgentSessionId(conversationId: string, sessionId: string): void;
  rememberRestoredSession(sessionId: string): void;
  saveResumeId(conversationId: string, resumeId: string): void;
  saveAgentEvents(conversationId: string, provider: string, events: AgentEvent[]): void;
  logger: AgentTurnLogger;
}

export async function executeAgentTurn(opts: ExecuteAgentTurnOptions): Promise<RunAgentTurnResult> {
  const { prompt, conversationId, sessionId, sourceMessageIds, anchor } = opts;
  const responder = opts.createResponder(anchor);
  const startBinding = await responder.start();
  opts.bindResponse(startBinding, conversationId);

  if (anchor.kind === 'proactive') {
    if (!startBinding.rootMessageId) {
      const error = new Error('发送主动任务根消息失败，无 messageId');
      opts.logger.error(error.message);
      return { status: 'failed', error };
    }

    opts.recordProactiveRootMessage({
      conversationId,
      rootMessageId: startBinding.rootMessageId,
      prompt,
      openId: anchor.openId,
    });
  }

  if (!startBinding.messageId) {
    const error = new Error('发送初始回复失败，无 messageId');
    opts.logger.error(error.message);
    return { status: 'failed', error };
  }

  if (startBinding.threadId) {
    await opts.agent.updateSessionContext?.(sessionId, opts.buildAgentSessionContext(conversationId));
  }

  const abortController = new AbortController();
  const activeRun: ActiveRun = {
    conversationId,
    sourceMessageIds: new Set(sourceMessageIds ?? (anchor.kind === 'reply' ? [anchor.parentMessageId] : [])),
    abortController,
    responder,
  };
  opts.activeRuns.set(conversationId, activeRun);

  const allEvents: AgentEvent[] = [];
  const displayEvents: AgentEvent[] = [];
  let resultText = '';
  let newSessionId: string | undefined;
  let lastUpdateTime = 0;
  let runError: Error | undefined;
  let replyMessageId = startBinding.messageId;
  const idleTimeoutMs = getAgentIdleTimeoutMs();

  try {
    const stream = opts.agent.sendMessageStream(sessionId, prompt, abortController.signal);

    while (true) {
      const iterResult = await nextAgentStreamEvent(stream, abortController, idleTimeoutMs);
      if (iterResult.done) {
        if (abortController.signal.aborted) {
          opts.logger.info(`任务被用户中断: ${conversationId}`);
          resultText = activeRun.cancelReason || DEFAULT_CANCEL_TEXT;
          stream.return?.(undefined as any).catch(() => {});
        }
        break;
      }

      const event = iterResult.value;
      allEvents.push(event);
      displayEvents.push(event);

      const fallbackSessionId = getFallbackSessionId(event);
      if (fallbackSessionId) {
        newSessionId = fallbackSessionId;
        opts.patchRequestContext({
          conversationId,
          sessionId: fallbackSessionId,
          provider: opts.getProviderNameForSession(fallbackSessionId),
        });
      }

      if (event.type === 'result') {
        resultText = event.content || '';
        continue;
      }

      if (shouldUpdateResponse(event)) {
        const now = Date.now();
        if (now - lastUpdateTime >= RESPONSE_UPDATE_INTERVAL_MS) {
          const binding = await responder.update({ events: displayEvents });
          opts.bindResponse(binding, conversationId);
          if (binding?.messageId) replyMessageId = binding.messageId;
          lastUpdateTime = now;
        }
      }
    }
  } catch (error: unknown) {
    if (error instanceof AgentRunIdleTimeoutError) {
      opts.logger.error(
        `Agent 流式处理 idle timeout: conv=${conversationId}, session=${sessionId}, timeoutMs=${error.idleTimeoutMs}`,
        error,
      );
    } else {
      opts.logger.error('Agent 流式处理异常:', error);
    }
    runError = error instanceof Error ? error : new Error(String(error));
    resultText = resultText || `处理出错: ${runError.message}`;
  }

  try {
    if (newSessionId) {
      opts.saveAgentSessionId(conversationId, newSessionId);
      opts.rememberRestoredSession(newSessionId);
      opts.logger.info(`Fallback 更新会话: ${conversationId} -> ${newSessionId}`);
    }

    const effectiveSessionId = newSessionId ?? sessionId;
    const resumeId = opts.agent.getResumeId(effectiveSessionId);
    if (resumeId) {
      opts.saveResumeId(conversationId, resumeId);
    }

    opts.saveAgentEvents(conversationId, opts.agent.name, allEvents);

    const finalBinding = await responder.complete({ events: displayEvents, text: resultText });
    opts.bindResponse(finalBinding, conversationId);
    if (finalBinding.messageId) replyMessageId = finalBinding.messageId;

    opts.logger.info(`处理完成，回复长度: ${resultText.length}`);
  } finally {
    try {
      const effectiveSessionId = newSessionId ?? sessionId;
      const resumeId = opts.agent.getResumeId(effectiveSessionId);
      if (resumeId) {
        opts.saveResumeId(conversationId, resumeId);
      }
    } catch (err) {
      opts.logger.warn('持久化 resume_id 失败:', err);
    }
    opts.activeRuns.deleteIfCurrent(conversationId, activeRun);
  }

  if (runError) {
    return { replyMessageId, status: 'failed', error: runError };
  }
  if (abortController.signal.aborted) {
    return { replyMessageId, status: 'cancelled' };
  }
  return { replyMessageId, status: 'success' };
}

function shouldUpdateResponse(event: AgentEvent): boolean {
  return event.type === 'tool_call'
    || event.type === 'thinking'
    || event.type === 'text'
    || event.type === 'notice';
}

function getFallbackSessionId(event: AgentEvent): string | undefined {
  return (event as AgentEvent & { metadata?: { newSessionId?: string } }).metadata?.newSessionId;
}
