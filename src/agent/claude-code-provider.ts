// Claude Code Provider — 基于 @anthropic-ai/claude-agent-sdk
// 让 Sage 中的 AI 就是"小克"：共享 agent_home 的 SOUL.md、USER.md、memory、skills

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultError, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentProvider, AgentSession, AgentResponse, AgentEvent, ClaudeCodeProviderConfig } from './types';
import { Logger } from '../utils';

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code';

  private logger: Logger;
  private sessions: Map<string, AgentSession> = new Map();
  // sessionId(我们的) -> Claude SDK session_id(SDK 返回的)
  private sdkSessionIds: Map<string, string> = new Map();

  private workDir: string;
  private maxTurns: number;
  private allowedTools: string[];
  private model: string;
  private systemPromptAppend: string;

  constructor(config: ClaudeCodeProviderConfig) {
    this.logger = new Logger('ClaudeCodeProvider');
    // 展开 ~ 为 HOME 路径
    this.workDir = config.workDir?.startsWith('~')
      ? config.workDir.replace('~', process.env.HOME || '')
      : (config.workDir ?? '');
    this.maxTurns = config.maxTurns ?? 30;
    this.allowedTools = config.allowedTools ?? [];
    this.model = config.model ?? 'claude-sonnet-4-6';

    // 读取 SOUL.md 和 USER.md，拼成 system prompt 追加内容
    this.systemPromptAppend = this.buildSystemPromptAppend();
  }

  /**
   * 构建 system prompt 追加内容（仅运行环境说明）
   * 身份(SOUL.md)、用户(USER.md)、记忆(MEMORY.md) 已通过 CLAUDE.md 的 @ 引用自动加载，无需重复注入
   */
  private buildSystemPromptAppend(): string {
    return [
      '',
      '# 运行环境说明',
      '你现在运行在 Sage 系统中，通过飞书接收用户消息。',
      `当前日期: ${new Date().toISOString().split('T')[0]}`,
    ].join('\n');
  }

  async initialize(): Promise<void> {
    this.logger.info('Claude Code SDK provider 初始化完成');
    this.logger.info(`workDir: ${this.workDir}`);
    this.logger.info(`model: ${this.model}`);
    this.logger.info(`systemPrompt 追加长度: ${this.systemPromptAppend.length} chars`);
  }

  async healthCheck(): Promise<boolean> {
    // SDK 底层 spawn Claude Code 子进程，继承 CLI 的 OAuth 认证
    // 只要 claude 命令可用就行
    try {
      const proc = Bun.spawnSync(['claude', '--version']);
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  async createSession(): Promise<AgentSession> {
    const id = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      if (event.type === 'result') {
        resultText = event.content || '';
      }
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
      options.allowedTools = this.allowedTools;
    }

    const sdkSessionId = this.sdkSessionIds.get(sessionId);
    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    this.logger.info(`调用 Claude SDK, message 长度: ${message.length}, resume: ${sdkSessionId || '新会话'}`);

    try {
      const q = claudeQuery({ prompt: message, options });

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
              const event: AgentEvent = {
                type: 'text',
                content: block.text,
                ts: new Date().toISOString(),
                persist: true,
              };
              yield event;
            } else if (block.type === 'tool_use') {
              const input = JSON.stringify(block.input ?? {}).slice(0, 150);
              this.logger.info(`[tool_use] ${block.name}  input: ${input}`);
              const event: AgentEvent = {
                type: 'tool_call',
                toolName: block.name,
                content: this.summarizeToolCall(block.name, block.input),
                toolDetail: this.extractToolDetail(block.name, block.input),
                ts: new Date().toISOString(),
                persist: true,
              };
              yield event;
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
          } else if (resultMsg.subtype === 'error_max_turns') {
            // max turns 不是致命错误，保存 session 以便 resume 继续
            this.logger.warn(`Claude SDK 达到最大步数: turns=${resultMsg.num_turns}, session=${resultMsg.session_id}`);
            if (resultMsg.session_id) {
              newSdkSessionId = resultMsg.session_id;
            }
            const notice = `\n\n⚠️ 已达到最大执行步数 (${resultMsg.num_turns} turns)，任务尚未完成。发送"继续"可接续当前任务。`;
            yield { type: 'text', content: notice, ts: new Date().toISOString(), persist: true };
            resultText = (resultText || '') + notice;
          } else if ('errors' in resultMsg) {
            const detail = this.formatSdkResultError(resultMsg as SDKResultError);
            this.logger.error(`Claude SDK 执行错误: ${detail.logMessage}`);
            yield { type: 'error', content: detail.userMessage, ts: new Date().toISOString(), persist: true };
            throw new Error(`Claude 执行错误: ${detail.userMessage}`);
          }
        }
      }

      if (newSdkSessionId) {
        this.sdkSessionIds.set(sessionId, newSdkSessionId);
        this.logger.info(`SDK session ID 已记录: ${newSdkSessionId}`);
      }

      session.updatedAt = Date.now();

      // 最后 yield result 事件
      yield { type: 'result', content: resultText || '（无回复内容）', ts: new Date().toISOString(), persist: false };

    } catch (error: any) {
      this.logger.error(
        `Claude SDK 调用失败: session=${sessionId}, resume=${sdkSessionId || '无'}, messageLen=${message.length}, error=${error?.message || '未知错误'}`
      );
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
    this.logger.info('Claude Code SDK provider 已销毁');
  }

  /** 生成 tool 调用的摘要（给人看的） */
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

  private formatSdkResultError(resultMsg: SDKResultError): { userMessage: string; logMessage: string } {
    const errors = (resultMsg.errors || [])
      .map(e => (typeof e === 'string' ? e.trim() : ''))
      .filter(Boolean);
    const errorText = errors.length > 0 ? errors.join('; ') : '';
    const meta = `subtype=${resultMsg.subtype}, turns=${resultMsg.num_turns}, stop_reason=${resultMsg.stop_reason ?? 'null'}, session=${resultMsg.session_id}`;
    const userMessage = errorText || `SDK结果错误(${resultMsg.subtype})，turns=${resultMsg.num_turns}, stop_reason=${resultMsg.stop_reason ?? 'null'}`;
    const logMessage = `${meta}, errors=${errorText || '[]'}`;
    return { userMessage, logMessage };
  }

  /** 提取需要持久化的 tool 详情（diff、command 等） */
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
