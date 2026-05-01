import type { AgentProvider, StructuredAgentResponse } from './types';
import { Logger } from '../utils';

export interface StructuredTask<T> {
  name: string;
  prompt: string;
  outputSchema: unknown;
  validate: (raw: string) => T;
  timeoutMs?: number;
  retries?: number;
}

export interface StructuredTaskResult<T> {
  value: T;
  raw: string;
  usage?: Record<string, unknown> | null;
  attempts: number;
}

export class StructuredAgentRunner {
  private logger = new Logger('StructuredAgentRunner');

  constructor(private provider: AgentProvider) {}

  async run<T>(task: StructuredTask<T>): Promise<StructuredTaskResult<T>> {
    if (!this.provider.runStructured) {
      throw new Error(`Provider ${this.provider.name} does not support structured output`);
    }

    const maxAttempts = Math.max(1, (task.retries ?? 1) + 1);
    let lastError: unknown;
    let lastRaw = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const abortController = new AbortController();
      const timeout = task.timeoutMs
        ? setTimeout(() => abortController.abort(`structured task timeout: ${task.name}`), task.timeoutMs)
        : null;

      try {
        const response = await this.provider.runStructured({
          prompt: this.buildPrompt(task, attempt, lastRaw, lastError),
          outputSchema: task.outputSchema,
          signal: abortController.signal,
        });
        lastRaw = response.raw;
        const value = task.validate(response.raw);
        return {
          value,
          raw: response.raw,
          usage: response.usage,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        this.logger.warn(`结构化任务失败: ${task.name}, attempt=${attempt}/${maxAttempts}, reason=${error instanceof Error ? error.message : String(error)}`);
        if (attempt === maxAttempts) {
          throw error;
        }
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildPrompt<T>(task: StructuredTask<T>, attempt: number, lastRaw: string, lastError: unknown): string {
    if (attempt === 1) return task.prompt;

    return [
      task.prompt,
      '',
      '上一次输出未通过本地校验。请重新完成同一任务，只输出符合 output schema 的 JSON，不要解释。',
      `校验错误: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastRaw ? `上一次原始输出:\n${lastRaw.slice(0, 4000)}` : '',
    ].filter(Boolean).join('\n');
  }
}

