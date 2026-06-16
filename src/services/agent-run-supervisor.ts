import type { AgentEvent } from '../agent/types';

const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_AGENT_IDLE_TIMEOUT_MS = 1;

export class AgentRunIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(`Agent provider stream idle timeout after ${idleTimeoutMs}ms without events; run was aborted`);
    this.name = 'AgentRunIdleTimeoutError';
  }
}

export function getAgentIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SAGE_AGENT_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_AGENT_IDLE_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_AGENT_IDLE_TIMEOUT_MS) {
    return DEFAULT_AGENT_IDLE_TIMEOUT_MS;
  }
  return parsed;
}

export async function nextAgentStreamEvent(
  stream: AsyncGenerator<AgentEvent>,
  abortController: AbortController,
  idleTimeoutMs: number,
): Promise<IteratorResult<AgentEvent>> {
  if (abortController.signal.aborted) {
    return { done: true, value: undefined };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  type SupervisedResult =
    | { kind: 'next'; result: IteratorResult<AgentEvent> }
    | { kind: 'next_error'; error: unknown }
    | { kind: 'aborted' }
    | { kind: 'timeout'; error: AgentRunIdleTimeoutError };

  const nextPromise: Promise<SupervisedResult> = stream.next().then(
    result => ({ kind: 'next' as const, result }),
    error => ({ kind: 'next_error' as const, error }),
  );

  const abortPromise = new Promise<SupervisedResult>((resolve) => {
    const onAbort = () => resolve({ kind: 'aborted' });
    abortController.signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => abortController.signal.removeEventListener('abort', onAbort);
  });

  const timeoutPromise = new Promise<SupervisedResult>((resolve) => {
    timeoutId = setTimeout(() => {
      const error = new AgentRunIdleTimeoutError(idleTimeoutMs);
      resolve({ kind: 'timeout', error });
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }, idleTimeoutMs);
  });

  try {
    const result = await Promise.race([nextPromise, abortPromise, timeoutPromise]);
    if (result.kind === 'next') return result.result;
    if (result.kind === 'next_error') throw result.error;
    if (result.kind === 'timeout') {
      stream.return?.(undefined as any).catch(() => {});
      throw result.error;
    }
    return { done: true, value: undefined };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}
