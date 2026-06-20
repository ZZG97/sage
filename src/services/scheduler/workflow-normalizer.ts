import type {
  DynamicTaskContext,
  DynamicTaskWriteOptions,
  WorkflowJobOptions,
  WorkflowStep,
  WorkflowTaskPayload,
} from './types';

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...(${text.length - maxChars} chars truncated)`;
}

export function summarizeWorkflowPayload(payload: WorkflowTaskPayload): string {
  return payload.steps
    .map((step, index) => {
      if (step.kind === 'shell') {
        return `${index + 1}. shell: ${truncateText(step.command.replace(/\s+/g, ' '), 100)}`;
      }
      return `${index + 1}. agent: ${truncateText(step.prompt.replace(/\s+/g, ' '), 100)}`;
    })
    .join('\n');
}

export function normalizeWorkflowJobOptions(input: unknown): WorkflowJobOptions | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object') {
    throw new Error('workflow.jobOptions 必须是对象');
  }

  const raw = input as Record<string, unknown>;
  const options: WorkflowJobOptions = {};

  if (raw.attempts !== undefined) {
    if (typeof raw.attempts !== 'number' || !Number.isInteger(raw.attempts) || raw.attempts <= 0) {
      throw new Error('workflow.jobOptions.attempts 必须是正整数');
    }
    options.attempts = raw.attempts;
  }

  if (raw.backoff !== undefined) {
    if (typeof raw.backoff !== 'number' || !Number.isFinite(raw.backoff) || raw.backoff < 0) {
      throw new Error('workflow.jobOptions.backoff 必须是非负数');
    }
    options.backoff = Math.floor(raw.backoff);
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

export function normalizeWorkflowPayload(input: unknown): WorkflowTaskPayload {
  if (!input || typeof input !== 'object') {
    throw new Error('workflow payload 必须是对象');
  }

  const raw = input as { version?: unknown; steps?: unknown; jobOptions?: unknown };
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error('workflow.steps 必须是非空数组');
  }

  const steps: WorkflowStep[] = raw.steps.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error(`workflow.steps[${index}] 必须是对象`);
    }

    const step = candidate as Record<string, unknown>;
    const id = typeof step.id === 'string' && step.id.trim()
      ? step.id.trim()
      : `step_${String(index + 1).padStart(2, '0')}`;

    if (step.kind === 'shell') {
      const command = typeof step.command === 'string' ? step.command.trim() : '';
      if (!command) {
        throw new Error(`workflow.steps[${index}].command 不能为空`);
      }
      const cwd = typeof step.cwd === 'string' && step.cwd.trim() ? step.cwd.trim() : null;
      const timeoutSec = typeof step.timeoutSec === 'number' && Number.isFinite(step.timeoutSec)
        ? Math.max(1, Math.floor(step.timeoutSec))
        : null;
      return { id, kind: 'shell', command, cwd, timeoutSec };
    }

    if (step.kind === 'agent') {
      const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : '';
      if (!prompt) {
        throw new Error(`workflow.steps[${index}].prompt 不能为空`);
      }
      const title = typeof step.title === 'string' && step.title.trim() ? step.title.trim() : null;
      return { id, kind: 'agent', prompt, title };
    }

    throw new Error(`workflow.steps[${index}].kind 仅支持 shell / agent`);
  });

  const jobOptions = normalizeWorkflowJobOptions(raw.jobOptions);

  return {
    version: 1,
    steps,
    ...(jobOptions ? { jobOptions } : {}),
  };
}

export function normalizeDynamicTaskContext(opts: DynamicTaskWriteOptions): DynamicTaskContext | null {
  const rawReuseConversationId = opts.reuseConversationId ?? opts.context?.reuseConversationId;
  const reuseConversationId = typeof rawReuseConversationId === 'string'
    ? rawReuseConversationId.trim()
    : '';
  return reuseConversationId ? { reuseConversationId } : null;
}
