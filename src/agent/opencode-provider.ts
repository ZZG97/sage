// OpenCode Provider — 封装现有的 OpenCode 逻辑

import { createOpencodeClient } from '@opencode-ai/sdk';
import { AgentProvider, AgentSession, AgentResponse, OpenCodeProviderConfig } from './types';
import { Logger } from '../utils';

export class OpenCodeProvider implements AgentProvider {
  readonly name = 'opencode';

  private client: ReturnType<typeof createOpencodeClient>;
  private logger: Logger;
  private sessions: Map<string, AgentSession> = new Map();

  constructor(config: OpenCodeProviderConfig) {
    this.logger = new Logger('OpenCodeProvider');
    this.client = createOpencodeClient({ baseUrl: config.baseUrl });
  }

  async initialize(): Promise<void> {
    const healthy = await this.healthCheck();
    if (!healthy) {
      throw new Error('OpenCode 服务不可用');
    }
    this.logger.info('OpenCode provider 初始化完成');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const sessions = await this.client.session.list();
      return sessions.data !== undefined;
    } catch (error) {
      this.logger.error('健康检查失败:', error);
      return false;
    }
  }

  async createSession(): Promise<AgentSession> {
    const response = await this.client.session.create({});
    if (!response.data?.id) {
      throw new Error('创建会话失败：没有返回会话ID');
    }

    const now = Date.now();
    const session: AgentSession = {
      id: response.data.id,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.id, session);
    this.logger.info(`会话创建: ${session.id}`);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<AgentResponse> {
    const response = await this.client.session.prompt({
      body: { parts: [{ type: 'text', text: message }] },
      path: { id: sessionId },
    });

    if (!response.data) {
      throw new Error('OpenCode 响应为空');
    }

    const text = this.extractText(response.data);

    // 更新会话活跃时间
    const session = this.sessions.get(sessionId);
    if (session) session.updatedAt = Date.now();

    return { text };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
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
        cleaned++;
      }
    }

    if (cleaned > 0) this.logger.info(`清理了 ${cleaned} 个过期会话`);
    return cleaned;
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
    this.logger.info('OpenCode provider 已销毁');
  }

  private extractText(data: any): string {
    if (typeof data === 'string') return data;
    if (data.parts && Array.isArray(data.parts)) {
      const texts = data.parts.filter((p: any) => p.type === 'text');
      if (texts.length > 0) return texts.map((p: any) => p.text).join('\n');
    }
    if (data.response) return data.response;
    if (data.text) return data.text;
    return '无法解析 AI 回复';
  }
}
