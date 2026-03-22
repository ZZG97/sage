// CC-MiniMax Provider — 基于 Claude Code SDK，但 API 指向 MiniMax 兼容端点
// 通过临时注入环境变量实现，不影响其他 provider

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentProvider, AgentSession, AgentResponse, AgentEvent, AgentResultEvent, CcMinimaxProviderConfig } from './types';
import { Logger } from '../utils';

export class CcMinimaxProvider implements AgentProvider {
  readonly name = 'cc-minimax';

  private logger: Logger;
  private sessions: Map<string, AgentSession> = new Map();
  private sdkSessionIds: Map<string, string> = new Map();

  private workDir: string;
  private maxTurns: number;
  private allowedTools: string[];
  // MiniMax API 不兼容的工具（搜索请求会路由到 MiniMax 端点导致 400）
  private static readonly DISABLED_TOOLS = ['WebSearch'];
  private model: string;
  private apiKey: string;
  private baseUrl: string;
  private systemPromptAppend: string;

  constructor(config: CcMinimaxProviderConfig) {
    this.logger = new Logger('CcMinimaxProvider');
    this.workDir = config.workDir?.startsWith('~')
      ? config.workDir.replace('~', process.env.HOME || '')
      : (config.workDir ?? '');
    this.maxTurns = config.maxTurns ?? 30;
    this.allowedTools = config.allowedTools ?? [];
    this.model = config.model || 'MiniMax-M2.7';
    this.apiKey = config.apiKey || '';
    this.baseUrl = config.baseUrl || 'https://api.minimaxi.com/anthropic';

    if (!this.apiKey) {
      this.logger.warn('CC_MINIMAX_API_KEY 未设置，调用时会失败');
    }

    this.systemPromptAppend = this.buildSystemPromptAppend();
  }

  private buildSystemPromptAppend(): string {
    return [
      '',
      '# 运行环境说明',
      '你现在运行在 Sage 系统中，通过飞书接收用户消息。',
      `当前日期: ${new Date().toISOString().split('T')[0]}`,
      `当前模型: ${this.model} (via cc-minimax provider)`,
    ].join('\n');
  }

  async initialize(): Promise<void> {
    this.logger.info('CC-MiniMax provider 初始化完成');
    this.logger.info(`workDir: ${this.workDir}`);
    this.logger.info(`model: ${this.model}`);
    this.logger.info(`baseUrl: ${this.baseUrl}`);
    this.logger.info(`apiKey: ${this.apiKey ? '已设置' : '未设置'}`);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const proc = Bun.spawnSync(['claude', '--version']);
      return proc.exitCode === 0 && !!this.apiKey;
    } catch {
      return false;
    }
  }

  async createSession(): Promise<AgentSession> {
    const id = `ccm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

  /**
   * 临时注入 MiniMax 环境变量，执行 fn，然后恢复原始环境
   * 确保 claude subprocess 带着 MiniMax 的配置启动，不污染全局
   */
  private withMinimaxEnv<T>(fn: () => T): T {
    const envOverrides: Record<string, string> = {
      ANTHROPIC_BASE_URL: this.baseUrl,
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      ANTHROPIC_MODEL: this.model,
      ANTHROPIC_SMALL_FAST_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };

    const saved: Record<string, string | undefined> = {};
    for (const [key, val] of Object.entries(envOverrides)) {
      saved[key] = process.env[key];
      process.env[key] = val;
    }

    try {
      return fn();
    } finally {
      for (const [key, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    }
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

  async *sendMessageStream(sessionId: string, message: string): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    const options: Record<string, any> = {
      cwd: this.workDir,
      model: this.model,
      maxTurns: this.maxTurns,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project' as const],
      systemPrompt: this.systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: this.systemPromptAppend }
        : { type: 'preset' as const, preset: 'claude_code' as const },
    };

    if (this.allowedTools.length > 0) {
      options.allowedTools = this.allowedTools.filter(t => !CcMinimaxProvider.DISABLED_TOOLS.includes(t));
    }
    options.disallowedTools = CcMinimaxProvider.DISABLED_TOOLS;

    const sdkSessionId = this.sdkSessionIds.get(sessionId);
    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    this.logger.info(`调用 CC-MiniMax, message 长度: ${message.length}, model: ${this.model}, resume: ${sdkSessionId || '新会话'}`);

    try {
      const q = this.withMinimaxEnv(() => claudeQuery({ prompt: message, options }));

      let resultText = '';
      let newSdkSessionId = '';

      for await (const msg of q) {
        if ('session_id' in msg && msg.session_id) {
          newSdkSessionId = msg.session_id;
        }

        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === 'text' && block.text?.trim()) {
              this.logger.debug(`[assistant] ${block.text.slice(0, 200)}`);
              yield { type: 'text', content: block.text, ts: new Date().toISOString(), persist: true };
            } else if (block.type === 'tool_use') {
              const input = JSON.stringify(block.input ?? {}).slice(0, 150);
              this.logger.info(`[tool_use] ${block.name}  input: ${input}`);
              yield {
                type: 'tool_call',
                toolName: block.name,
                content: this.summarizeToolCall(block.name, block.input),
                toolDetail: this.extractToolDetail(block.name, block.input),
                ts: new Date().toISOString(),
                persist: true,
              };
            } else if (block.type === 'thinking') {
              yield { type: 'thinking', ts: new Date().toISOString(), persist: false };
            }
          }
        } else if (msg.type === 'user') {
          const content = (msg as any).message?.content ?? [];
          for (const block of content) {
            if (block.type === 'tool_result') {
              this.logger.debug(`[tool_result] tool_use_id=${block.tool_use_id}`);
              yield { type: 'tool_result', ts: new Date().toISOString(), persist: false };
            }
          }
        } else if (msg.type === 'system') {
          this.logger.debug(`[system] subtype=${(msg as any).subtype}`);
        } else if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.subtype === 'success' && 'result' in resultMsg) {
            resultText = resultMsg.result;
          } else if ('errors' in resultMsg) {
            const errorMsg = (resultMsg as any).errors?.join('; ') || '未知错误';
            this.logger.error(`CC-MiniMax 执行错误: ${errorMsg}`);
            yield { type: 'error', content: errorMsg, ts: new Date().toISOString(), persist: true };
            throw new Error(`CC-MiniMax 执行错误: ${errorMsg}`);
          }
        }
      }

      if (newSdkSessionId) {
        this.sdkSessionIds.set(sessionId, newSdkSessionId);
        this.logger.info(`SDK session ID 已记录: ${newSdkSessionId}`);
      }

      session.updatedAt = Date.now();
      yield { type: 'result', content: resultText || '（无回复内容）', ts: new Date().toISOString(), persist: false };

    } catch (error: any) {
      this.logger.error(`CC-MiniMax 调用失败: ${error.message}`);
      throw error;
    }
  }

  getResumeId(sessionId: string): string | undefined {
    return this.sdkSessionIds.get(sessionId);
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
      this.sdkSessionIds.set(sessionId, resumeId);
    }
    this.logger.info(`会话恢复: ${sessionId}, resumeId: ${resumeId || '无'}`);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.sdkSessionIds.delete(sessionId);
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
        this.sdkSessionIds.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) this.logger.info(`清理了 ${cleaned} 个过期会话`);
    return cleaned;
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
    this.sdkSessionIds.clear();
    this.logger.info('CC-MiniMax provider 已销毁');
  }

  private summarizeToolCall(name: string, input: any): string {
    if (!input) return name;
    switch (name) {
      case 'Read':
        return `Read ${input.file_path ?? ''}`;
      case 'Write':
        return `Write ${input.file_path ?? ''}`;
      case 'Edit':
        return `Edit ${input.file_path ?? ''}`;
      case 'Bash':
        return `Bash: ${(input.command ?? '').slice(0, 100)}`;
      case 'Glob':
        return `Glob ${input.pattern ?? ''}`;
      case 'Grep':
        return `Grep "${input.pattern ?? ''}"`;
      case 'WebSearch':
        return `WebSearch "${input.query ?? ''}"`;
      case 'WebFetch':
        return `WebFetch ${input.url ?? ''}`;
      case 'Agent':
        return `Agent: ${input.description ?? ''}`;
      default:
        return `${name}: ${JSON.stringify(input).slice(0, 100)}`;
    }
  }

  private extractToolDetail(name: string, input: any): string | undefined {
    if (!input) return undefined;
    switch (name) {
      case 'Edit':
        return JSON.stringify({
          file: input.file_path,
          old: input.old_string,
          new: input.new_string,
        });
      case 'Write':
        return JSON.stringify({
          file: input.file_path,
          contentLength: input.content?.length ?? 0,
        });
      case 'Bash':
        return JSON.stringify({ command: input.command });
      default:
        return undefined;
    }
  }
}
