// Claude Code Provider — 基于 @anthropic-ai/claude-agent-sdk
// 让 Sage 中的 AI 就是"小克"：共享 agent_home 的 SOUL.md、USER.md、memory、skills

import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentProvider, AgentSession, AgentResponse, ClaudeCodeProviderConfig } from './types';
import { Logger } from '../utils';
import { readFileSync } from 'fs';
import { join } from 'path';

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
    this.workDir = config.workDir.startsWith('~')
      ? config.workDir.replace('~', process.env.HOME || '')
      : config.workDir;
    this.maxTurns = config.maxTurns ?? 30;
    this.allowedTools = config.allowedTools ?? [];
    this.model = config.model ?? 'claude-sonnet-4-6';

    // 读取 SOUL.md 和 USER.md，拼成 system prompt 追加内容
    this.systemPromptAppend = this.buildSystemPromptAppend();
  }

  /**
   * 读取 agent_home 下的身份文件，构建 system prompt 追加内容
   */
  private buildSystemPromptAppend(): string {
    const parts: string[] = [];

    // 读取 SOUL.md
    try {
      const soulPath = join(this.workDir, 'memory', 'SOUL.md');
      const soul = readFileSync(soulPath, 'utf-8');
      parts.push(soul);
    } catch (e) {
      this.logger.warn('无法读取 SOUL.md，将不注入身份信息');
    }

    // 读取 USER.md
    try {
      const userPath = join(this.workDir, 'memory', 'USER.md');
      const user = readFileSync(userPath, 'utf-8');
      parts.push(user);
    } catch (e) {
      this.logger.warn('无法读取 USER.md，将不注入用户信息');
    }

    if (parts.length === 0) return '';

    return [
      '',
      '# 身份与用户上下文（来自 agent_home）',
      '',
      ...parts,
      '',
      '# 运行环境说明',
      '你现在运行在 Sage 系统中，通过飞书接收用户消息。',
      '你可以读写 agent_home 下的 memory 文件来记住和回忆信息。',
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
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`会话不存在: ${sessionId}`);
    }

    // 构建 query options
    const options: Record<string, any> = {
      cwd: this.workDir,
      model: this.model,
      maxTurns: this.maxTurns,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      // 加载 agent_home 下的 CLAUDE.md 和 .claude/settings.json
      settingSources: ['project' as const],
      // 用 claude_code preset + 追加小克身份
      systemPrompt: this.systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: this.systemPromptAppend }
        : { type: 'preset' as const, preset: 'claude_code' as const },
    };

    // 如果有允许的工具列表
    if (this.allowedTools.length > 0) {
      options.allowedTools = this.allowedTools;
    }

    // 多轮对话：resume 之前的 SDK session
    const sdkSessionId = this.sdkSessionIds.get(sessionId);
    if (sdkSessionId) {
      options.resume = sdkSessionId;
    }

    this.logger.info(`调用 Claude SDK, message 长度: ${message.length}, resume: ${sdkSessionId || '新会话'}`);

    try {
      // 调用 SDK query
      const q = claudeQuery({ prompt: message, options });

      let resultText = '';
      let newSdkSessionId = '';

      // 消费 stream，收集结果
      for await (const msg of q) {
        // 记录 session_id 用于后续 resume
        if ('session_id' in msg && msg.session_id) {
          newSdkSessionId = msg.session_id;
        }

        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          if (resultMsg.subtype === 'success' && 'result' in resultMsg) {
            resultText = resultMsg.result;
          } else if ('errors' in resultMsg) {
            const errorMsg = (resultMsg as any).errors?.join('; ') || '未知错误';
            this.logger.error(`Claude SDK 执行错误: ${errorMsg}`);
            throw new Error(`Claude 执行错误: ${errorMsg}`);
          }
        }
      }

      // 保存 SDK session ID 用于多轮
      if (newSdkSessionId) {
        this.sdkSessionIds.set(sessionId, newSdkSessionId);
        this.logger.info(`SDK session ID 已记录: ${newSdkSessionId}`);
      }

      // 更新会话时间
      session.updatedAt = Date.now();

      return { text: resultText || '（无回复内容）' };

    } catch (error: any) {
      this.logger.error(`Claude SDK 调用失败: ${error.message}`);
      throw error;
    }
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
}
