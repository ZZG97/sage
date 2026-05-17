// Codex Provider — 基于 @openai/codex-sdk
// 让 Sage 可以使用 OpenAI Codex 作为 Agent 后端

import { Codex, Thread } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { AgentProvider, AgentSession, AgentResponse, AgentEvent, AgentSessionContext, CodexProviderConfig, StructuredAgentInput, StructuredAgentResponse } from './types';
import { Logger, sanitizeLogValue } from '../utils';

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  private logger: Logger;
  private defaultCodex: Codex;
  private sessions: Map<string, AgentSession> = new Map();
  // sessionId(我们的) -> Codex Thread
  private threads: Map<string, Thread> = new Map();
  // sessionId -> Codex thread_id（用于 resume）
  private threadIds: Map<string, string> = new Map();
  // sessionId -> 专属 Codex client（用于隔离 env）
  private codexClients: Map<string, Codex> = new Map();

  private workDir: string;
  private model: string;
  private reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  private sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(config: CodexProviderConfig) {
    this.logger = new Logger('CodexProvider');
    this.workDir = config.workDir?.startsWith('~')
      ? config.workDir.replace('~', process.env.HOME || '')
      : (config.workDir ?? process.cwd());
    this.model = config.model ?? 'gpt-5.3-codex';
    this.reasoningEffort = config.reasoningEffort;
    this.sandboxMode = config.sandboxMode ?? 'danger-full-access';

    // apiKey 可选：有则用 API key 认证，无则走 ~/.codex/auth.json（ChatGPT 订阅）
    this.defaultCodex = this.createCodexClient();
  }

  async initialize(): Promise<void> {
    this.logger.info('Codex provider 初始化完成');
    this.logger.info(`workDir: ${this.workDir}`);
    this.logger.info(`model: ${this.model}`);
    this.logger.info(`reasoningEffort: ${this.reasoningEffort || 'default'}`);
    this.logger.info(`sandboxMode: ${this.sandboxMode}`);
  }

  async healthCheck(): Promise<boolean> {
    // 检查认证：API key 或 ChatGPT 订阅登录（~/.codex/auth.json）
    if (process.env.OPENAI_API_KEY) return true;
    try {
      const authFile = Bun.file(`${process.env.HOME}/.codex/auth.json`);
      return await authFile.exists();
    } catch {
      return false;
    }
  }

  async createSession(context?: AgentSessionContext): Promise<AgentSession> {
    const id = `cdx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const session: AgentSession = {
      id,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: context ? { sessionContext: context } : undefined,
    };

    this.sessions.set(id, session);
    this.logger.info(`会话创建: ${id}`);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<AgentResponse> {
    const events: AgentEvent[] = [];
    let resultText = '';

    for await (const event of this.sendMessageStream(sessionId, message)) {
      events.push(event);
      if (event.type === 'result') resultText = event.content || '';
    }

    return { text: resultText || '（无回复内容）', events };
  }

  async *sendMessageStream(sessionId: string, message: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    let thread = this.threads.get(sessionId);
    const existingThreadId = this.threadIds.get(sessionId);

    if (!thread) {
      const threadOptions = {
        model: this.model,
        sandboxMode: this.sandboxMode,
        workingDirectory: this.workDir,
        approvalPolicy: 'never' as const,
        skipGitRepoCheck: true,
        modelReasoningEffort: this.reasoningEffort,
      };

      if (existingThreadId) {
        thread = this.getCodexForSession(sessionId).resumeThread(existingThreadId, threadOptions);
        this.logger.info(`恢复 Codex thread: ${existingThreadId}`);
      } else {
        thread = this.getCodexForSession(sessionId).startThread(threadOptions);
        this.logger.info('创建新 Codex thread');
      }
      this.threads.set(sessionId, thread);
    }

    this.logger.info(`调用 Codex, message 长度: ${message.length}`);

    try {
      const { events: eventStream } = await thread.runStreamed(message, signal ? { signal } : undefined);
      let resultText = '';

      for await (const event of eventStream) {
        if (event.type === 'thread.started') {
          this.threadIds.set(sessionId, event.thread_id);
          this.logger.info(`Codex thread ID: ${event.thread_id}`);
        }

        if (event.type === 'item.completed') {
          const item = event.item;
          const agentEvent = this.itemToEvent(item);
          if (agentEvent) yield agentEvent;

          if (item.type === 'agent_message') {
            resultText = item.text;
          }
        }

        if (event.type === 'item.started') {
          this.logItemStarted(event.item);
        }

        if (event.type === 'turn.failed') {
          const errorMsg = event.error.message;
          this.logger.error(`Codex turn 失败: ${errorMsg}`);
          yield { type: 'error', content: errorMsg, ts: new Date().toISOString(), persist: true };
          throw new Error(`Codex 执行错误: ${errorMsg}`);
        }

        if (event.type === 'error') {
          this.logger.error(`Codex stream 错误: ${event.message}`);
        }

        if (event.type === 'turn.completed') {
          const u = event.usage;
          this.logger.info(`Codex tokens — in: ${u.input_tokens}, cached: ${u.cached_input_tokens}, out: ${u.output_tokens}`);
        }
      }

      session.updatedAt = Date.now();
      yield { type: 'result', content: resultText || '（无回复内容）', ts: new Date().toISOString(), persist: false };

    } catch (error: any) {
      this.threads.delete(sessionId);
      if (isAbortError(error) || signal?.aborted) {
        this.logger.info(`Codex 调用已取消: session=${sessionId}, messageLen=${message.length}`);
        throw error;
      }
      this.logger.error('Codex 调用失败', error);
      throw error;
    }
  }

  async runStructured(input: StructuredAgentInput): Promise<StructuredAgentResponse> {
    const thread = this.defaultCodex.startThread({
      model: this.model,
      sandboxMode: 'read-only',
      workingDirectory: this.workDir,
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
      modelReasoningEffort: this.reasoningEffort,
      webSearchMode: 'disabled',
      webSearchEnabled: false,
      networkAccessEnabled: false,
    });

    this.logger.info(`调用 Codex structured, prompt 长度: ${input.prompt.length}`);
    const result = await thread.run(input.prompt, {
      outputSchema: input.outputSchema,
      signal: input.signal,
    });

    return {
      raw: result.finalResponse,
      usage: result.usage ? { ...result.usage } : null,
    };
  }

  getResumeId(sessionId: string): string | undefined {
    return this.threadIds.get(sessionId);
  }

  updateSessionContext(sessionId: string, context: AgentSessionContext): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const previous = this.getSessionContext(session);
    if (this.sameSessionContext(previous, context)) return;

    session.metadata = { ...(session.metadata ?? {}), sessionContext: context };
    this.codexClients.delete(sessionId);
    this.threads.delete(sessionId);
    this.logger.info(
      `更新 Codex session 上下文: session=${sessionId}, conv=${context.conversationId || '无'}, thread=${context.threadId || '无'}`
    );
  }

  async restoreSession(sessionId: string, resumeId?: string, context?: AgentSessionContext): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: sessionId,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: context ? { sessionContext: context } : undefined,
    };
    this.sessions.set(sessionId, session);
    if (resumeId) {
      // 只存 threadId，Thread 对象在下次 sendMessage 时通过 resumeThread 懒创建
      this.threadIds.set(sessionId, resumeId);
    }
    this.logger.info(`会话恢复: ${sessionId}, threadId: ${resumeId || '无'}`);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.threads.delete(sessionId);
    this.threadIds.delete(sessionId);
    this.codexClients.delete(sessionId);
    this.logger.info(`会话已删除: ${sessionId}`);
  }

  getActiveSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  async cleanupSessions(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (now - session.updatedAt > maxAgeMs) {
        this.sessions.delete(id);
        this.threads.delete(id);
        this.threadIds.delete(id);
        this.codexClients.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) this.logger.info(`清理了 ${cleaned} 个过期会话`);
    return cleaned;
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
    this.threads.clear();
    this.threadIds.clear();
    this.codexClients.clear();
    this.logger.info('Codex provider 已销毁');
  }

  private createCodexClient(env?: Record<string, string>): Codex {
    const codexOptions: Record<string, any> = {};
    if (process.env.OPENAI_API_KEY) {
      codexOptions.apiKey = process.env.OPENAI_API_KEY;
    }
    if (env) {
      codexOptions.env = env;
    }
    return new Codex(codexOptions);
  }

  private getCodexForSession(sessionId: string): Codex {
    const existing = this.codexClients.get(sessionId);
    if (existing) return existing;

    const session = this.sessions.get(sessionId);
    const env = this.buildSessionEnv(sessionId, this.getSessionContext(session));
    const client = this.createCodexClient(env);
    this.codexClients.set(sessionId, client);
    return client;
  }

  private getSessionContext(session: AgentSession | undefined): AgentSessionContext | undefined {
    const value = session?.metadata?.sessionContext;
    if (!value || typeof value !== 'object') return undefined;
    return value as AgentSessionContext;
  }

  private sameSessionContext(a?: AgentSessionContext, b?: AgentSessionContext): boolean {
    return a?.conversationId === b?.conversationId
      && a?.threadId === b?.threadId
      && a?.openId === b?.openId
      && a?.chatId === b?.chatId
      && a?.chatType === b?.chatType;
  }

  private buildSessionEnv(sessionId: string, context?: AgentSessionContext): Record<string, string> | undefined {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.SAGE_AGENT_PROVIDER = this.name;
    env.SAGE_AGENT_SESSION_ID = sessionId;

    if (context?.conversationId) env.SAGE_CONVERSATION_ID = context.conversationId;
    if (context?.threadId) env.SAGE_THREAD_ID = context.threadId;
    if (context?.openId) env.SAGE_OPEN_ID = context.openId;
    if (context?.chatId) env.SAGE_CHAT_ID = context.chatId;
    if (context?.chatType) env.SAGE_CHAT_TYPE = context.chatType;

    if (!context) return env;
    this.logger.debug(
      `为 Codex session 注入 env: session=${sessionId}, conv=${context.conversationId || '无'}, thread=${context.threadId || '无'}`
    );
    return env;
  }

  /** 将 Codex ThreadItem 转换为 AgentEvent */
  private itemToEvent(item: ThreadItem): AgentEvent | null {
    const ts = new Date().toISOString();

    switch (item.type) {
      case 'agent_message':
        this.logger.debug(`[agent_message] ${item.text.slice(0, 200)}`);
        return {
          type: 'text',
          content: item.text,
          ts,
          persist: true,
        };

      case 'command_execution':
        this.logger.info(`[command] ${sanitizeLogValue(item.command, 160)} → exit=${item.exit_code}`);
        return {
          type: 'tool_call',
          toolName: 'command',
          content: `Command: ${item.command.slice(0, 100)}`,
          toolDetail: JSON.stringify({
            command: item.command,
            exit_code: item.exit_code,
            output: item.aggregated_output?.slice(0, 500),
          }),
          ts,
          persist: true,
        };

      case 'file_change':
        const files = item.changes.map(c => `${c.kind} ${c.path}`).join(', ');
        this.logger.info(`[file_change] ${files}`);
        return {
          type: 'tool_call',
          toolName: 'file_change',
          content: `Files: ${files.slice(0, 200)}`,
          toolDetail: JSON.stringify({ changes: item.changes }),
          ts,
          persist: true,
        };

      case 'mcp_tool_call':
        this.logger.info(`[mcp] ${item.server}/${item.tool}`);
        return {
          type: 'tool_call',
          toolName: `mcp:${item.server}/${item.tool}`,
          content: `MCP: ${item.server}/${item.tool}`,
          ts,
          persist: true,
        };

      case 'web_search':
        this.logger.info(`[web_search] ${sanitizeLogValue(item.query, 160)}`);
        return {
          type: 'tool_call',
          toolName: 'web_search',
          content: `WebSearch: ${item.query}`,
          ts,
          persist: true,
        };

      case 'reasoning':
        // reasoning 不持久化，仅日志
        this.logger.debug(`[reasoning] ${item.text.slice(0, 100)}`);
        return {
          type: 'thinking',
          content: item.text,
          ts,
          persist: false,
        };

      case 'error':
        this.logger.error(`[error] ${item.message}`);
        return {
          type: 'error',
          content: item.message,
          ts,
          persist: true,
        };

      case 'todo_list':
        // todo_list 不持久化
        return null;

      default:
        return null;
    }
  }

  /** 打印 item 开始的日志 */
  private logItemStarted(item: ThreadItem): void {
    switch (item.type) {
      case 'command_execution':
        this.logger.debug(`[command start] ${sanitizeLogValue(item.command, 160)}`);
        break;
      case 'agent_message':
        this.logger.debug(`[message start]`);
        break;
      case 'reasoning':
        this.logger.debug(`[reasoning start]`);
        break;
    }
  }
}
