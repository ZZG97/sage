// FallbackAgentProvider — 包装多个 provider，支持手动切换 + 自动降级

import { AgentProvider, AgentSession, AgentResponse, AgentEvent, AgentSessionContext } from './types';
import { Logger } from '../utils';

function isAbortError(error: any): boolean {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

/** 查询 conversationId 对应的最近对话历史（由外部注入，避免直接依赖 HistoryStore） */
export type RecentHistoryFn = (conversationId: string, maxTurns: number) => Array<{ role: string; content: string }>;

export class UnknownProviderSessionOwnerError extends Error {
  readonly code = 'UNKNOWN_PROVIDER_SESSION_OWNER';

  constructor(sessionId: string, availableProviders: string[]) {
    super(
      `Unknown provider owner for session ${sessionId}; available providers: ${availableProviders.join(', ')}`
    );
    this.name = 'UnknownProviderSessionOwnerError';
  }
}

export class FallbackAgentProvider implements AgentProvider {
  readonly name: string;

  private providers: Map<string, AgentProvider> = new Map();
  private providerOrder: string[]; // 按优先级排列的 provider 名称
  private logger: Logger;

  /** 自动降级开关（默认关闭） */
  private _autoFallbackEnabled: boolean = false;
  /** 当前活跃 provider 名称（用于新会话） */
  private _activeProviderName: string;

  /** agent_session_id → conversationId 映射，由 SageCore 注册 */
  private sessionToConversation: Map<string, string> = new Map();
  private sessionOwners: Map<string, string> = new Map();
  private sessionContexts: Map<string, AgentSessionContext> = new Map();
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

  /** 注册 sessionId → conversationId 映射（SageCore 每次发消息前调用） */
  registerSessionConversation(sessionId: string, conversationId: string): void {
    this.sessionToConversation.set(sessionId, conversationId);
  }

  /** 注册 provider session 的真实 owner。owner 来自持久化 storage 或新建 session 返回值。 */
  registerSessionOwner(sessionId: string, providerName: string): boolean {
    if (!this.providers.has(providerName)) {
      this.logger.warn(`注册 session owner 失败，未知 provider: session=${sessionId}, provider=${providerName}`);
      return false;
    }
    this.sessionOwners.set(sessionId, providerName);
    return true;
  }

  /** 返回已知 owner；必要时只做 legacy/内存推断，不会回落到 active provider。 */
  getSessionOwner(sessionId: string): string | null {
    return this.resolveProviderName(sessionId);
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

  async createSession(context?: AgentSessionContext): Promise<AgentSession> {
    const active = this.providers.get(this._activeProviderName)!;
    try {
      const session = await active.createSession(context);
      this.rememberSessionOwner(session, active.name);
      if (context) this.sessionContexts.set(session.id, context);
      return session;
    } catch (err) {
      if (!this._autoFallbackEnabled) throw err;
      // 尝试其他 provider
      for (const name of this.providerOrder) {
        if (name === this._activeProviderName) continue;
        try {
          const provider = this.providers.get(name)!;
          this.logger.warn(`${this._activeProviderName} createSession 失败，降级到 ${name}:`, err);
          const session = await provider.createSession(context);
          this.rememberSessionOwner(session, name);
          if (context) this.sessionContexts.set(session.id, context);
          return session;
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
      if (signal?.aborted || isAbortError(err)) {
        this.logger.info(`Provider 调用已取消: provider=${provider.name}, session=${sessionId}`);
        throw err;
      }

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

          const sessionContext = this.sessionContexts.get(sessionId);
          const newSession = await fallback.createSession(sessionContext);
          this.rememberSessionOwner(newSession, name);
          if (sessionContext) this.sessionContexts.set(newSession.id, sessionContext);
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
              event.metadata = {
                ...(event.metadata ?? {}),
                newSessionId: newSession.id,
                newSessionProvider: name,
              };
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

  async updateSessionContext(sessionId: string, context: AgentSessionContext): Promise<void> {
    this.sessionContexts.set(sessionId, context);
    await this.routeProvider(sessionId).updateSessionContext?.(sessionId, context);
  }

  async restoreSession(sessionId: string, resumeId?: string, context?: AgentSessionContext): Promise<AgentSession> {
    const session = await this.routeProvider(sessionId).restoreSession(sessionId, resumeId, context);
    this.rememberSessionOwner(session, session.provider);
    if (context) this.sessionContexts.set(session.id, context);
    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const provider = this.routeProvider(sessionId);
    this.sessionContexts.delete(sessionId);
    this.sessionOwners.delete(sessionId);
    return provider.deleteSession(sessionId);
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
    const activeSessionIds = new Set(this.getActiveSessions().map(session => session.id));
    for (const sessionId of this.sessionContexts.keys()) {
      if (!activeSessionIds.has(sessionId)) this.sessionContexts.delete(sessionId);
    }
    for (const sessionId of this.sessionOwners.keys()) {
      if (!activeSessionIds.has(sessionId)) this.sessionOwners.delete(sessionId);
    }
    return total;
  }

  async destroy(): Promise<void> {
    this.sessionOwners.clear();
    this.sessionContexts.clear();
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

    const conversationId = this.sessionToConversation.get(originalSessionId);
    if (!conversationId) {
      this.logger.warn(`无法找到 sessionId ${originalSessionId} 对应的 conversationId，跳过上下文注入`);
      return message;
    }

    const history = this.getRecentHistory(conversationId, 5);
    if (history.length === 0) {
      this.logger.info(`未命中历史上下文: conversation=${conversationId}, session=${originalSessionId}`);
      return message;
    }

    const historyText = history
      .map(h => `${h.role === 'user' ? '用户' : '助手'}: ${h.content}`)
      .join('\n');

    this.logger.info(
      `注入降级上下文: conversation=${conversationId}, session=${originalSessionId}, turns=${history.length}, historyChars=${historyText.length}, messageChars=${message.length}`
    );

    return `[上下文恢复] 由于服务切换，以下是之前的对话记录供参考：\n${historyText}\n---\n${message}`;
  }

  private routeProvider(sessionId: string): AgentProvider {
    const providerName = this.resolveProviderName(sessionId);
    if (!providerName) {
      throw new UnknownProviderSessionOwnerError(sessionId, this.providerOrder);
    }
    return this.providers.get(providerName)!;
  }

  private resolveProviderName(sessionId: string): string | null {
    const registeredOwner = this.sessionOwners.get(sessionId);
    if (registeredOwner && this.providers.has(registeredOwner)) {
      return registeredOwner;
    }
    if (registeredOwner) {
      this.logger.warn(`清理失效 session owner: session=${sessionId}, provider=${registeredOwner}`);
      this.sessionOwners.delete(sessionId);
    }

    // 进程内已有 session 可以直接定位 owner。
    for (const [name, provider] of this.providers) {
      if (provider.getActiveSessions().some(s => s.id === sessionId)) {
        this.sessionOwners.set(sessionId, name);
        return name;
      }
    }

    const legacyProvider = this.getLegacyProviderName(sessionId);
    if (legacyProvider) {
      this.logger.warn(`通过 legacy session 前缀推断 provider owner: session=${sessionId}, provider=${legacyProvider}`);
      this.sessionOwners.set(sessionId, legacyProvider);
      return legacyProvider;
    }

    return null;
  }

  private rememberSessionOwner(session: AgentSession, fallbackProviderName: string): void {
    const providerName = this.providers.has(session.provider) ? session.provider : fallbackProviderName;
    this.sessionOwners.set(session.id, providerName);
  }

  /** 判断是否应该降级（反向逻辑：只有明确的业务错误才不降级） */
  private isFallbackEligible(error: any): boolean {
    const msg = (error?.message || '').toLowerCase();
    if (msg.includes('content policy') || msg.includes('content_policy')) return false;
    if (msg.includes('safety') || msg.includes('moderation')) return false;
    return true;
  }

  private getLegacyProviderName(sessionId: string): string | null {
    for (const name of this.providerOrder) {
      const prefix = this.getProviderPrefix(name);
      if (prefix && sessionId.startsWith(prefix)) return name;
    }
    return null;
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
