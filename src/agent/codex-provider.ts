// Codex Provider — 基于 @openai/codex-sdk
// 让 Sage 可以使用 OpenAI Codex 作为 Agent 后端

import { Codex, Thread } from '@openai/codex-sdk';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { AgentProvider, AgentSession, AgentResponse, AgentEvent, CodexProviderConfig } from './types';
import { Logger } from '../utils';

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';

  private logger: Logger;
  private codex: Codex;
  private sessions: Map<string, AgentSession> = new Map();
  // sessionId(我们的) -> Codex Thread
  private threads: Map<string, Thread> = new Map();
  // sessionId -> Codex thread_id（用于 resume）
  private threadIds: Map<string, string> = new Map();

  private workDir: string;
  private model: string;
  private sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';

  constructor(config: CodexProviderConfig) {
    this.logger = new Logger('CodexProvider');
    this.workDir = config.workDir?.startsWith('~')
      ? config.workDir.replace('~', process.env.HOME || '')
      : (config.workDir ?? process.cwd());
    this.model = config.model ?? 'gpt-5.3-codex';
    this.sandboxMode = config.sandboxMode ?? 'danger-full-access';

    // apiKey 可选：有则用 API key 认证，无则走 ~/.codex/auth.json（ChatGPT 订阅）
    const codexOptions: Record<string, any> = {};
    if (process.env.OPENAI_API_KEY) {
      codexOptions.apiKey = process.env.OPENAI_API_KEY;
    }
    this.codex = new Codex(codexOptions);
  }

  async initialize(): Promise<void> {
    this.logger.info('Codex provider 初始化完成');
    this.logger.info(`workDir: ${this.workDir}`);
    this.logger.info(`model: ${this.model}`);
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

  async createSession(): Promise<AgentSession> {
    const id = `cdx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const session: AgentSession = {
      id,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
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
      };

      if (existingThreadId) {
        thread = this.codex.resumeThread(existingThreadId, threadOptions);
        this.logger.info(`恢复 Codex thread: ${existingThreadId}`);
      } else {
        thread = this.codex.startThread(threadOptions);
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
      this.logger.error(`Codex 调用失败: ${error.message}`);
      throw error;
    }
  }

  getResumeId(sessionId: string): string | undefined {
    return this.threadIds.get(sessionId);
  }

  async restoreSession(sessionId: string, resumeId?: string): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: sessionId,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
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
    this.logger.info('Codex provider 已销毁');
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
        this.logger.info(`[command] ${item.command} → exit=${item.exit_code}`);
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
        this.logger.info(`[web_search] ${item.query}`);
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
        this.logger.info(`[command start] ${item.command}`);
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
