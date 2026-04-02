// FallbackAgentProvider — 包装多个 provider，支持手动切换 + 自动降级

import { AgentProvider, AgentSession, AgentResponse, AgentEvent } from './types';
import { Logger } from '../utils';

/** 查询 threadKey 对应的最近对话历史（由外部注入，避免直接依赖 HistoryStore） */
export type RecentHistoryFn = (threadKey: string, maxTurns: number) => Array<{ role: string; content: string }>;

export class FallbackAgentProvider implements AgentProvider {
  readonly name: string;

  private providers: Map<string, AgentProvider> = new Map();
  private providerOrder: string[]; // 按优先级排列的 provider 名称
  private logger: Logger;

  /** 自动降级开关（默认关闭） */
  private _autoFallbackEnabled: boolean = false;
  /** 当前活跃 provider 名称（用于新会话） */
  private _activeProviderName: string;

  /** agent_session_id → threadKey 映射，由 SageCore 注册 */
  private sessionToThread: Map<string, string> = new Map();
  private getRecentHistory?: RecentHistoryFn;

  constructor(providerList: AgentProvider[]) {
    if (providerList.length < 2) {
      throw new Error('FallbackAgentProvider 至少需要 2 个 provider');
    }
    for (const p of providerList) {
      this.providers.set(p.name, p);
    }
    this.providerOrder = providerList.map(p => p.name);
    this._activeProviderName = this.providerOrder[0];
    this.name = this.providerOrder.join('+');
    this.logger = new Logger('FallbackProvider');
  }

  /** 获取/设置自动降级开关 */
  get autoFallbackEnabled(): boolean { return this._autoFallbackEnabled; }
  setAutoFallback(enabled: boolean): void {
    this._autoFallbackEnabled = enabled;
    this.logger.info(`自动降级已${enabled ? '开启' : '关闭'}`);
  }

  /** 获取当前活跃 provider 名称（用于新会话） */
  get activeProviderName(): string { return this._activeProviderName; }

  /** 获取所有可用 provider 名称 */
  get availableProviders(): string[] { return [...this.providerOrder]; }

  /** 切换活跃 provider（影响新会话，已有会话不受影响） */
  switchActiveProvider(name: string): boolean {
    if (this.providers.has(name)) {
      this._activeProviderName = name;
      this.logger.info(`活跃 provider 切换为: ${name}`);
      return true;
    }
    return false;
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
    // 活跃 provider 必须初始化成功，其余失败不阻塞
    const active = this.providers.get(this._activeProviderName)!;
    await active.initialize();

    for (const [name, provider] of this.providers) {
      if (name === this._activeProviderName) continue;
      try {
        await provider.initialize();
      } catch (err) {
        this.logger.warn(`Provider (${name}) 初始化失败，切换时将重试:`, err);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    const active = this.providers.get(this._activeProviderName)!;
    if (await active.healthCheck()) return true;
    // 尝试其他 provider
    for (const [name, provider] of this.providers) {
      if (name === this._activeProviderName) continue;
      if (await provider.healthCheck()) return true;
    }
    return false;
  }

  async createSession(): Promise<AgentSession> {
    const active = this.providers.get(this._activeProviderName)!;
    try {
      return await active.createSession();
    } catch (err) {
      if (!this._autoFallbackEnabled) throw err;
      // 尝试其他 provider
      for (const name of this.providerOrder) {
        if (name === this._activeProviderName) continue;
        try {
          const provider = this.providers.get(name)!;
          this.logger.warn(`${this._activeProviderName} createSession 失败，降级到 ${name}:`, err);
          return await provider.createSession();
        } catch { /* try next */ }
      }
      throw err;
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
      if (!this._autoFallbackEnabled || !this.isFallbackEligible(err)) {
        this.logger.warn(
          `不触发降级: provider=${provider.name}, autoFallback=${this._autoFallbackEnabled}, session=${sessionId}, messageLen=${message.length}, reason=${errSummary}`
        );
        throw err;
      }

      // 按优先级尝试其他 provider
      for (const name of this.providerOrder) {
        if (name === provider.name) continue;
        const fallback = this.providers.get(name)!;

        try {
          this.logger.warn(
            `${provider.name} sendMessageStream 失败，降级到 ${name}: session=${sessionId}, messageLen=${message.length}, reason=${errSummary}`
          );

          const newSession = await fallback.createSession();
          this.logger.warn(`创建降级会话: oldSession=${sessionId}, newSession=${newSession.id}, provider=${name}`);

          const enrichedMessage = this.buildFallbackMessage(sessionId, message);

          yield {
            type: 'notice',
            content: `⚠️ ${provider.name} 异常，已自动切换到 ${name}`,
            ts: new Date().toISOString(),
            persist: false,
          };

          for await (const event of fallback.sendMessageStream(newSession.id, enrichedMessage, signal)) {
            if (event.type === 'result') {
              (event as any).metadata = { newSessionId: newSession.id };
            }
            yield event;
          }
          return; // 降级成功，结束
        } catch (fallbackErr) {
          this.logger.warn(`降级到 ${name} 也失败:`, fallbackErr);
          // 继续尝试下一个
        }
      }

      // 所有 provider 都失败
      throw err;
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
    const sessions: AgentSession[] = [];
    for (const provider of this.providers.values()) {
      sessions.push(...provider.getActiveSessions());
    }
    return sessions;
  }

  async cleanupSessions(maxAgeMs: number): Promise<number> {
    let total = 0;
    for (const provider of this.providers.values()) {
      total += await provider.cleanupSessions(maxAgeMs);
    }
    return total;
  }

  async destroy(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.destroy();
    }
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
    // 按前缀匹配
    for (const [name, provider] of this.providers) {
      const prefix = this.getProviderPrefix(name);
      if (prefix && sessionId.startsWith(prefix)) {
        return provider;
      }
    }

    // 前缀不匹配时，按实际持有 session 判断
    for (const [, provider] of this.providers) {
      if (provider.getActiveSessions().some(s => s.id === sessionId)) {
        return provider;
      }
    }

    // 默认活跃 provider
    return this.providers.get(this._activeProviderName)!;
  }

  /** 判断是否应该降级（反向逻辑：只有明确的业务错误才不降级） */
  private isFallbackEligible(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();
    if (msg.includes('content policy') || msg.includes('content_policy')) return false;
    if (msg.includes('safety') || msg.includes('moderation')) return false;
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
