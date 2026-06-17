import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentEvent,
  AgentProvider,
  AgentResponse,
  AgentSession,
  AgentSessionContext,
  StructuredAgentInput,
  StructuredAgentResponse,
} from '../agent/types';
import { FallbackAgentProvider } from '../agent/fallback-provider';
import type { MessageContext } from '../types';
import { HistoryStore } from './history-store';
import { InMemoryMessageGateway } from './in-memory-message-gateway';
import { SageCore } from './core';

class FakeAgentProvider implements AgentProvider {
  readonly name: string;
  private sessionCounter = 1;
  private sessions = new Map<string, AgentSession>();
  readonly receivedMessages: Array<{ sessionId: string; message: string }> = [];

  constructor(name = 'fake-agent') {
    this.name = name;
  }

  async initialize(): Promise<void> {}

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async createSession(context?: AgentSessionContext): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: `fake-${this.sessionCounter++}`,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: context ? { ...context } : undefined,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async sendMessage(sessionId: string, message: string): Promise<AgentResponse> {
    const events = [
      this.event('result', `Echo: ${message}`),
    ];
    return { text: `Echo: ${message}`, events };
  }

  async *sendMessageStream(sessionId: string, message: string): AsyncGenerator<AgentEvent> {
    this.receivedMessages.push({ sessionId, message });
    yield this.event('tool_call', 'fake tool', 'FakeTool');
    yield this.event('result', `Echo: ${message}`);
  }

  async runStructured(_input: StructuredAgentInput): Promise<StructuredAgentResponse> {
    return { raw: '{}' };
  }

  updateSessionContext(sessionId: string, context: AgentSessionContext): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...(session.metadata ?? {}), ...context };
      session.updatedAt = Date.now();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  getActiveSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  async cleanupSessions(): Promise<number> {
    return 0;
  }

  async restoreSession(sessionId: string, _resumeId?: string, context?: AgentSessionContext): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const now = Date.now();
    const session: AgentSession = {
      id: sessionId,
      provider: this.name,
      createdAt: now,
      updatedAt: now,
      metadata: context ? { ...context } : undefined,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getResumeId(sessionId: string): string | undefined {
    return `resume-${sessionId}`;
  }

  async destroy(): Promise<void> {
    this.sessions.clear();
  }

  private event(type: string, content: string, toolName?: string): AgentEvent {
    return {
      type,
      content,
      toolName,
      ts: new Date().toISOString(),
      persist: true,
    };
  }
}

class IdleAgentProvider extends FakeAgentProvider {
  readonly name = 'idle-agent';
  aborted = false;

  override async *sendMessageStream(
    sessionId: string,
    message: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    this.receivedMessages.push({ sessionId, message });
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        this.aborted = true;
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => {
        this.aborted = true;
        resolve();
      }, { once: true });
    });
  }
}

class NewSessionMetadataAgentProvider extends FakeAgentProvider {
  readonly name = 'new-session-agent';

  override async *sendMessageStream(sessionId: string, message: string): AsyncGenerator<AgentEvent> {
    this.receivedMessages.push({ sessionId, message });
    yield {
      type: 'result',
      content: `Echo after fallback: ${message}`,
      ts: new Date().toISOString(),
      persist: true,
      metadata: { newSessionId: 'fake-fallback-42', newSessionProvider: this.name },
    };
  }
}

const tempDirs: string[] = [];
const originalRestartEnv = {
  OWNER_OPEN_ID: process.env.OWNER_OPEN_ID,
  name: process.env.name,
  SAGE_INSTANCE: process.env.SAGE_INSTANCE,
  SAGE_AGENT_IDLE_TIMEOUT_MS: process.env.SAGE_AGENT_IDLE_TIMEOUT_MS,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv('OWNER_OPEN_ID', originalRestartEnv.OWNER_OPEN_ID);
  restoreEnv('name', originalRestartEnv.name);
  restoreEnv('SAGE_INSTANCE', originalRestartEnv.SAGE_INSTANCE);
  restoreEnv('SAGE_AGENT_IDLE_TIMEOUT_MS', originalRestartEnv.SAGE_AGENT_IDLE_TIMEOUT_MS);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createCoreHarness(options: {
  restartExecutor?: (command: string) => void;
} = {}): {
  core: SageCore;
  agent: FakeAgentProvider;
  historyStore: HistoryStore;
  gateway: InMemoryMessageGateway;
  destroy: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
  tempDirs.push(dir);
  const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
  const agent = new FakeAgentProvider();
  const gateway = new InMemoryMessageGateway();
  const core = new SageCore(agent, historyStore, gateway, options);
  return {
    core,
    agent,
    historyStore,
    gateway,
    destroy: () => historyStore.destroy(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function completedTexts(gateway: InMemoryMessageGateway): string[] {
  return gateway.outboundMessages
    .filter(message => message.type === 'response_complete')
    .map(message => message.text);
}

function testMessage(overrides: Partial<MessageContext> = {}): MessageContext {
  return {
    text: ' hello Sage ',
    openId: 'ou_test',
    chatId: 'oc_test',
    chatType: 'p2p',
    messageId: 'om_test_1',
    ...overrides,
  };
}

describe('SageCore message gateway boundary', () => {
  it('does not register process signal handlers from Core.start', async () => {
    const { core, destroy } = createCoreHarness();
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');

    try {
      await core.start();

      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);

      await core.stop();

      expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    } finally {
      if (core.getStatus().isRunning) {
        await core.stop();
      }
      destroy();
    }
  });

  it('processes an injected message through Core without Feishu transport', async () => {
    const { agent, historyStore, gateway, destroy } = createCoreHarness();

    try {
      await gateway.emitMessage(testMessage());

      expect(agent.receivedMessages).toEqual([
        { sessionId: 'fake-1', message: 'hello Sage' },
      ]);

      const session = historyStore.getSessionByFirstMessageId('om_test_1');
      expect(session).not.toBeNull();
      expect(session?.thread_id).toBe('test_thread_1');
      expect(session?.agent_session_id).toBe('fake-1');
      expect(session?.agent_session_provider).toBe('fake-agent');
      expect(session?.resume_id).toBe('resume-fake-1');

      const events = historyStore.getSessionEvents(session!.id);
      expect(events.map((event) => [event.role, event.type, event.content])).toContainEqual([
        'user',
        'text',
        'hello Sage',
      ]);
      expect(events.map((event) => [event.role, event.type, event.content])).toContainEqual([
        'assistant',
        'result',
        'Echo: hello Sage',
      ]);

      const starts = gateway.outboundMessages.filter((message) => message.type === 'response_start');
      const completions = gateway.outboundMessages.filter((message) => message.type === 'response_complete');
      expect(starts).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(completions.at(-1)).toMatchObject({
        type: 'response_complete',
        text: 'Echo: hello Sage',
      });
    } finally {
      destroy();
    }
  });

  it('does not apply restart ownership checks to ordinary messages', async () => {
    process.env.OWNER_OPEN_ID = 'ou_owner';
    const { agent, destroy, gateway } = createCoreHarness();

    try {
      await gateway.emitMessage(testMessage({ openId: 'ou_not_owner' }));

      expect(agent.receivedMessages).toEqual([
        { sessionId: 'fake-1', message: 'hello Sage' },
      ]);
    } finally {
      destroy();
    }
  });

  it('handles synchronous slash commands before agent queueing', async () => {
    const { agent, destroy, gateway } = createCoreHarness();

    try {
      await gateway.emitMessage(testMessage({
        text: ' /help ',
        messageId: 'om_help',
      }));

      expect(agent.receivedMessages).toHaveLength(0);
      expect(completedTexts(gateway).at(-1)).toContain('/restart - 优雅重启服务');
      expect(completedTexts(gateway).at(-1)).toContain('• 当前 Agent: fake-agent');
      expect(gateway.outboundMessages.find(message =>
        message.type === 'response_start' && message.parentMessageId === 'om_help'
      )).toBeDefined();
    } finally {
      destroy();
    }
  });

  it('routes replies by stored first message id across Core instances', async () => {
    const { historyStore, gateway, destroy } = createCoreHarness();

    try {
      await gateway.emitMessage(testMessage({
        text: 'first turn',
        messageId: 'om_root_db',
      }));

      const session = historyStore.getSessionByFirstMessageId('om_root_db');
      expect(session).not.toBeNull();
      expect(session?.agent_session_id).toBe('fake-1');
      expect(session?.agent_session_provider).toBe('fake-agent');

      const nextAgent = new FakeAgentProvider();
      const nextGateway = new InMemoryMessageGateway();
      new SageCore(nextAgent, historyStore, nextGateway);

      await nextGateway.emitMessage(testMessage({
        text: 'reply turn',
        messageId: 'om_reply_db',
        rootId: 'om_root_db',
      }));

      expect(nextAgent.receivedMessages).toEqual([
        { sessionId: 'fake-1', message: 'reply turn' },
      ]);
      expect(historyStore.getSessionByFirstMessageId('om_reply_db')).toBeNull();

      const events = historyStore.getSessionEvents(session!.id);
      expect(events.map((event) => [event.role, event.type, event.content])).toContainEqual([
        'user',
        'text',
        'first turn',
      ]);
      expect(events.map((event) => [event.role, event.type, event.content])).toContainEqual([
        'user',
        'text',
        'reply turn',
      ]);
    } finally {
      destroy();
    }
  });

  it('prioritizes thread routing before reply root routing', async () => {
    const { agent, historyStore, gateway, destroy } = createCoreHarness();

    try {
      await gateway.emitMessage(testMessage({
        text: 'conversation a',
        messageId: 'om_thread_a',
      }));
      await gateway.emitMessage(testMessage({
        text: 'conversation b',
        messageId: 'om_thread_b',
      }));

      const sessionA = historyStore.getSessionByFirstMessageId('om_thread_a');
      const sessionB = historyStore.getSessionByFirstMessageId('om_thread_b');
      expect(sessionA?.thread_id).toBe('test_thread_1');
      expect(sessionB?.thread_id).toBe('test_thread_2');

      await gateway.emitMessage(testMessage({
        text: 'thread wins',
        messageId: 'om_thread_conflict',
        threadId: sessionB!.thread_id!,
        rootId: 'om_thread_a',
      }));

      expect(agent.receivedMessages.at(-1)).toEqual({
        sessionId: sessionB!.agent_session_id!,
        message: 'thread wins',
      });

      const events = historyStore.getSessionEvents(sessionB!.id);
      expect(events.map((event) => [event.role, event.type, event.content])).toContainEqual([
        'user',
        'text',
        'thread wins',
      ]);
    } finally {
      destroy();
    }
  });

  it('cancels an active run when the source message is recalled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
    tempDirs.push(dir);
    const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
    const agent = new IdleAgentProvider();
    const gateway = new InMemoryMessageGateway();
    new SageCore(agent, historyStore, gateway);

    try {
      const run = gateway.emitMessage(testMessage({
        text: 'cancel me',
        messageId: 'om_recalled_active',
      }));
      await waitFor(() => agent.receivedMessages.length === 1);

      await gateway.emitRecall('om_recalled_active');
      await run;

      expect(agent.aborted).toBe(true);
      expect(completedTexts(gateway).at(-1)).toBe('⏹ 已因用户撤回原消息而取消。');
    } finally {
      historyStore.destroy();
    }
  });

  it('persists fallback session metadata from agent stream events', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
    tempDirs.push(dir);
    const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
    const agent = new NewSessionMetadataAgentProvider();
    const gateway = new InMemoryMessageGateway();
    new SageCore(agent, historyStore, gateway);

    try {
      await gateway.emitMessage(testMessage({
        text: 'fallback turn',
        messageId: 'om_fallback_metadata',
      }));

      const session = historyStore.getSessionByFirstMessageId('om_fallback_metadata');
      expect(session?.agent_session_id).toBe('fake-fallback-42');
      expect(session?.agent_session_provider).toBe('new-session-agent');
      expect(session?.resume_id).toBe('resume-fake-fallback-42');
      expect(completedTexts(gateway).at(-1)).toBe('Echo after fallback: fallback turn');

      await gateway.emitMessage(testMessage({
        text: 'after fallback',
        messageId: 'om_after_fallback',
        threadId: session!.thread_id!,
      }));

      expect(agent.receivedMessages.at(-1)).toEqual({
        sessionId: 'fake-fallback-42',
        message: 'after fallback',
      });
    } finally {
      historyStore.destroy();
    }
  });

  it('persists provider session owner and restores through it instead of the active provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
    tempDirs.push(dir);
    const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
    const codex = new FakeAgentProvider('codex');
    const claude = new FakeAgentProvider('claude-code');
    const firstGateway = new InMemoryMessageGateway();
    new SageCore(new FallbackAgentProvider([codex, claude]), historyStore, firstGateway);

    try {
      await firstGateway.emitMessage(testMessage({
        text: 'first on codex',
        messageId: 'om_owner_first',
      }));

      const session = historyStore.getSessionByFirstMessageId('om_owner_first');
      expect(session?.agent_session_id).toBe('fake-1');
      expect(session?.agent_session_provider).toBe('codex');

      const nextCodex = new FakeAgentProvider('codex');
      const nextClaude = new FakeAgentProvider('claude-code');
      const fallback = new FallbackAgentProvider([nextCodex, nextClaude]);
      fallback.switchActiveProvider('claude-code');
      const nextGateway = new InMemoryMessageGateway();
      new SageCore(fallback, historyStore, nextGateway);

      await nextGateway.emitMessage(testMessage({
        text: 'reply should stay on codex',
        messageId: 'om_owner_reply',
        rootId: 'om_owner_first',
      }));

      expect(nextCodex.receivedMessages).toEqual([
        { sessionId: 'fake-1', message: 'reply should stay on codex' },
      ]);
      expect(nextClaude.receivedMessages).toHaveLength(0);
    } finally {
      historyStore.destroy();
    }
  });

  it('creates a new visible session when fallback owner is missing and cannot be inferred', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
    tempDirs.push(dir);
    const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
    const conversationId = historyStore.createConversation('codex+claude-code', {
      firstMessageId: 'om_missing_owner_root',
      openId: 'ou_test',
      chatId: 'oc_test',
      chatType: 'p2p',
    });
    historyStore.updateAgentSessionId(conversationId, 'legacy-providerless-session');

    const codex = new FakeAgentProvider('codex');
    const claude = new FakeAgentProvider('claude-code');
    const gateway = new InMemoryMessageGateway();
    new SageCore(new FallbackAgentProvider([codex, claude]), historyStore, gateway);

    try {
      await gateway.emitMessage(testMessage({
        text: 'reply after missing owner',
        messageId: 'om_missing_owner_reply',
        rootId: 'om_missing_owner_root',
      }));

      expect(codex.receivedMessages).toEqual([
        { sessionId: 'fake-1', message: 'reply after missing owner' },
      ]);
      const session = historyStore.getSession(conversationId);
      expect(session?.agent_session_id).toBe('fake-1');
      expect(session?.agent_session_provider).toBe('codex');

      const updates = gateway.outboundMessages.filter((message) => message.type === 'response_update');
      expect(updates.at(-1)?.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'notice',
          content: expect.stringContaining('历史会话缺少 provider owner'),
        }),
      ]));
    } finally {
      historyStore.destroy();
    }
  });

  it('allows /restart for OWNER_OPEN_ID and executes the prod restart command', async () => {
    process.env.OWNER_OPEN_ID = 'ou_owner';
    process.env.name = 'sage';
    delete process.env.SAGE_INSTANCE;
    const restartCommands: string[] = [];
    const { agent, destroy, gateway } = createCoreHarness({
      restartExecutor: (command) => {
        restartCommands.push(command);
      },
    });

    try {
      await gateway.emitMessage(testMessage({
        text: '/restart',
        openId: 'ou_owner',
        messageId: 'om_restart_owner',
      }));
      await waitFor(() => restartCommands.length === 1);

      expect(restartCommands).toEqual(['bun run prod:restart']);
      expect(agent.receivedMessages).toHaveLength(0);
      expect(completedTexts(gateway)).toContain('✅ 服务即将重启，请稍后发送消息继续。');
    } finally {
      destroy();
    }
  });

  it('rejects /restart from non-owner when OWNER_OPEN_ID is configured', async () => {
    process.env.OWNER_OPEN_ID = 'ou_owner';
    process.env.name = 'sage';
    const restartCommands: string[] = [];
    const { agent, destroy, gateway } = createCoreHarness({
      restartExecutor: (command) => {
        restartCommands.push(command);
      },
    });

    try {
      await gateway.emitMessage(testMessage({
        text: '/restart',
        openId: 'ou_intruder',
        messageId: 'om_restart_intruder',
      }));

      expect(restartCommands).toHaveLength(0);
      expect(agent.receivedMessages).toHaveLength(0);
      expect(completedTexts(gateway).at(-1)).toContain('只有 OWNER_OPEN_ID 配置的 owner 可以重启服务');
    } finally {
      destroy();
    }
  });

  it('rejects /restart in prod when OWNER_OPEN_ID is not configured', async () => {
    delete process.env.OWNER_OPEN_ID;
    process.env.name = 'sage';
    delete process.env.SAGE_INSTANCE;
    const restartCommands: string[] = [];
    const { agent, destroy, gateway } = createCoreHarness({
      restartExecutor: (command) => {
        restartCommands.push(command);
      },
    });

    try {
      await gateway.emitMessage(testMessage({
        text: '/restart',
        openId: 'ou_anyone',
        messageId: 'om_restart_no_owner_prod',
      }));

      expect(restartCommands).toHaveLength(0);
      expect(agent.receivedMessages).toHaveLength(0);
      expect(completedTexts(gateway).at(-1)).toContain('生产环境必须配置 OWNER_OPEN_ID');
    } finally {
      destroy();
    }
  });

  it('allows p2p /restart in dev when OWNER_OPEN_ID is not configured', async () => {
    delete process.env.OWNER_OPEN_ID;
    process.env.name = 'sage-dev';
    const restartCommands: string[] = [];
    const { agent, destroy, gateway } = createCoreHarness({
      restartExecutor: (command) => {
        restartCommands.push(command);
      },
    });

    try {
      await gateway.emitMessage(testMessage({
        text: '/restart',
        openId: 'ou_dev',
        messageId: 'om_restart_no_owner_dev',
        chatType: 'p2p',
      }));
      await waitFor(() => restartCommands.length === 1);

      expect(restartCommands).toEqual(['bun run dev:restart']);
      expect(agent.receivedMessages).toHaveLength(0);
    } finally {
      destroy();
    }
  });

  it('aborts and fails a provider stream that never produces events', async () => {
    process.env.SAGE_AGENT_IDLE_TIMEOUT_MS = '20';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-core-test-'));
    tempDirs.push(dir);
    const historyStore = new HistoryStore(path.join(dir, 'history.db'), 'test');
    const agent = new IdleAgentProvider();
    const gateway = new InMemoryMessageGateway();
    const core = new SageCore(agent, historyStore, gateway);

    try {
      await gateway.emitMessage(testMessage());

      expect(agent.aborted).toBe(true);

      const completions = gateway.outboundMessages.filter((message) => message.type === 'response_complete');
      expect(completions.at(-1)).toMatchObject({
        type: 'response_complete',
        text: '处理出错: Agent provider stream idle timeout after 20ms without events; run was aborted',
      });

      await gateway.emitMessage(testMessage({
        text: '/stop',
        messageId: 'om_stop_1',
        threadId: 'test_thread_1',
      }));

      const stopCompletion = gateway.outboundMessages.filter((message) => message.type === 'response_complete').at(-1);
      expect(stopCompletion).toMatchObject({
        type: 'response_complete',
        text: '当前话题没有正在执行的任务。',
      });
    } finally {
      historyStore.destroy();
    }
  });
});
