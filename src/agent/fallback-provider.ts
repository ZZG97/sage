// FallbackAgentProvider — 包装 primary + fallback 两个 provider，异常自动降级

import { AgentProvider, AgentSession, AgentResponse } from './types';
import { Logger } from '../utils';

export class FallbackAgentProvider implements AgentProvider {
  readonly name: string;

  private primary: AgentProvider;
  private fallback: AgentProvider;
  private logger: Logger;

  constructor(primary: AgentProvider, fallback: AgentProvider) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}+${fallback.name}`;
    this.logger = new Logger('FallbackProvider');
  }

  async initialize(): Promise<void> {
    // 两个都初始化，但 fallback 失败不阻塞启动
    await this.primary.initialize();
    try {
      await this.fallback.initialize();
    } catch (err) {
      this.logger.warn(`Fallback provider (${this.fallback.name}) 初始化失败，降级时将重试:`, err);
    }
  }

  async healthCheck(): Promise<boolean> {
    const primaryOk = await this.primary.healthCheck();
    if (primaryOk) return true;
    return this.fallback.healthCheck();
  }

  async createSession(): Promise<AgentSession> {
    try {
      return await this.primary.createSession();
    } catch (err) {
      this.logger.warn(`Primary (${this.primary.name}) createSession 失败，降级到 ${this.fallback.name}:`, err);
      return this.fallback.createSession();
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<AgentResponse> {
    const provider = this.routeProvider(sessionId);

    try {
      return await provider.sendMessage(sessionId, message);
    } catch (err: any) {
      // 已经在 fallback 上或不可降级，直接抛
      if (provider === this.fallback || !this.isFallbackEligible(err)) {
        throw err;
      }

      this.logger.warn(`Primary (${this.primary.name}) sendMessage 失败，降级到 ${this.fallback.name}: ${err.message}`);

      // 在 fallback 上创建新 session 并发送消息
      const newSession = await this.fallback.createSession();
      const response = await this.fallback.sendMessage(newSession.id, message);

      // 通过 metadata 通知 SageCore 更新 DB
      response.metadata = { ...response.metadata, newSessionId: newSession.id };

      // 在回复前加降级提示
      response.text = `⚠️ ${this.primary.name} 异常，已自动切换到 ${this.fallback.name}\n\n${response.text}`;

      return response;
    }
  }

  getResumeId(sessionId: string): string | undefined {
    return this.routeProvider(sessionId).getResumeId(sessionId);
  }

  async restoreSession(sessionId: string, resumeId?: string): Promise<AgentSession> {
    return this.routeProvider(sessionId).restoreSession(sessionId, resumeId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.routeProvider(sessionId).deleteSession(sessionId);
  }

  getActiveSessions(): AgentSession[] {
    return [
      ...this.primary.getActiveSessions(),
      ...this.fallback.getActiveSessions(),
    ];
  }

  async cleanupSessions(maxAgeMs: number): Promise<number> {
    const a = await this.primary.cleanupSessions(maxAgeMs);
    const b = await this.fallback.cleanupSessions(maxAgeMs);
    return a + b;
  }

  async destroy(): Promise<void> {
    await this.primary.destroy();
    await this.fallback.destroy();
  }

  /** 根据 sessionId 前缀路由到对应 provider */
  private routeProvider(sessionId: string): AgentProvider {
    const fallbackPrefix = this.getProviderPrefix(this.fallback.name);
    if (fallbackPrefix && sessionId.startsWith(fallbackPrefix)) {
      return this.fallback;
    }
    return this.primary;
  }

  /** 判断是否应该降级到 fallback（反向逻辑：只有明确的业务错误才不降级） */
  private isFallbackEligible(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();

    // 不降级：内容审核/安全拒绝（用户输入问题，换 provider 也一样）
    if (msg.includes('content policy') || msg.includes('content_policy')) return false;
    if (msg.includes('safety') || msg.includes('moderation')) return false;

    // 其余错误均降级（网络、超时、provider 不可用、API 错误等）
    return true;
  }

  private getProviderPrefix(name: string): string {
    switch (name) {
      case 'claude-code': return 'cc-';
      case 'codex': return 'cdx-';
      case 'opencode': return 'oc-';
      default: return '';
    }
  }
}
