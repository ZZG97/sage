// FallbackAgentProvider — 包装 primary + fallback 两个 provider，异常自动降级

import { AgentProvider, AgentSession, AgentResponse, AgentEvent } from './types';
import { Logger } from '../utils';

/** 查询 threadKey 对应的最近对话历史（由外部注入，避免直接依赖 HistoryStore） */
export type RecentHistoryFn = (threadKey: string, maxTurns: number) => Array<{ role: string; content: string }>;

export class FallbackAgentProvider implements AgentProvider {
  readonly name: string;

  private primary: AgentProvider;
  private fallback: AgentProvider;
  private logger: Logger;

  /** agent_session_id → threadKey 映射，由 SageCore 注册 */
  private sessionToThread: Map<string, string> = new Map();
  private getRecentHistory?: RecentHistoryFn;

  constructor(primary: AgentProvider, fallback: AgentProvider) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}+${fallback.name}`;
    this.logger = new Logger('FallbackProvider');
  }

  /** 注入历史查询函数（由 SageCore 在初始化后调用） */
  setRecentHistoryFn(fn: RecentHistoryFn): void {
    this.getRecentHistory = fn;
  }

  /** 注册 sessionId → threadKey 映射（SageCore 每次发消息前调用） */
  registerSessionThread(sessionId: string, threadKey: string): void {
    this.sessionToThread.set(sessionId, threadKey);
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
    const events: AgentEvent[] = [];
    let resultText = '';

    for await (const event of this.sendMessageStream(sessionId, message)) {
      events.push(event);
      if (event.type === 'result') resultText = event.content || '';
    }

    return { text: resultText || '（无回复内容）', events };
  }

  async *sendMessageStream(sessionId: string, message: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const provider = this.routeProvider(sessionId);

    try {
      yield* provider.sendMessageStream(sessionId, message, signal);
    } catch (err: any) {
      const errSummary = this.describeError(err);
      if (provider === this.fallback || !this.isFallbackEligible(err)) {
        this.logger.warn(
          `不触发降级: provider=${provider.name}, session=${sessionId}, messageLen=${message.length}, reason=${errSummary}`
        );
        throw err;
      }

      this.logger.warn(
        `Primary (${this.primary.name}) sendMessageStream 失败，降级到 ${this.fallback.name}: session=${sessionId}, messageLen=${message.length}, reason=${errSummary}`
      );

      const newSession = await this.fallback.createSession();
      this.logger.warn(`创建 fallback 会话: oldSession=${sessionId}, newSession=${newSession.id}`);

      // 构建带上下文的消息
      const enrichedMessage = this.buildFallbackMessage(sessionId, message);

      // yield 降级提示事件（notice 类型，卡片中独立渲染，不会被 resultText 覆盖）
      yield {
        type: 'notice',
        content: `⚠️ ${this.primary.name} 异常，已自动切换到 ${this.fallback.name}`,
        ts: new Date().toISOString(),
        persist: false,
      };

      // 代理 fallback 的流式输出，拦截 result 事件注入 metadata
      for await (const event of this.fallback.sendMessageStream(newSession.id, enrichedMessage, signal)) {
        if (event.type === 'result') {
          // 注入 newSessionId metadata（通过特殊字段，SageCore 检查）
          (event as any).metadata = { newSessionId: newSession.id };
        }
        yield event;
      }
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

  /** 降级时构建带历史上下文的消息 */
  private buildFallbackMessage(originalSessionId: string, message: string): string {
    if (!this.getRecentHistory) {
      this.logger.warn(`未注入 RecentHistoryFn，跳过上下文恢复: session=${originalSessionId}`);
      return message;
    }

    const threadKey = this.sessionToThread.get(originalSessionId);
    if (!threadKey) {
      this.logger.warn(`无法找到 sessionId ${originalSessionId} 对应的 threadKey，跳过上下文注入`);
      return message;
    }

    const history = this.getRecentHistory(threadKey, 5);
    if (history.length === 0) {
      this.logger.info(`未命中历史上下文: thread=${threadKey}, session=${originalSessionId}`);
      return message;
    }

    const historyText = history
      .map(h => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`)
      .join('\n');

    this.logger.info(
      `注入降级上下文: thread=${threadKey}, session=${originalSessionId}, turns=${history.length}, historyChars=${historyText.length}, messageChars=${message.length}`
    );

    return `[上下文恢复] 由于服务切换，以下是之前的对话记录供参考：\n${historyText}\n---\n${message}`;
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
      case 'cc-minimax': return 'ccm-';
      case 'codex': return 'cdx-';
      case 'opencode': return 'oc-';
      default: return '';
    }
  }

  private describeError(error: any): string {
    if (!error) return 'unknown';
    const name = typeof error?.name === 'string' ? error.name : 'Error';
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = typeof error?.message === 'string' ? error.message : String(error);
    const stackLine = typeof error?.stack === 'string' ? error.stack.split('\n')[1]?.trim() : '';
    const parts = [`name=${name}`];
    if (code) parts.push(`code=${code}`);
    parts.push(`message=${message}`);
    if (stackLine) parts.push(`at=${stackLine}`);
    return parts.join(', ');
  }
}
