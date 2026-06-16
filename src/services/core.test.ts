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
import type { MessageContext } from '../types';
import { HistoryStore } from './history-store';
import { InMemoryMessageGateway } from './in-memory-message-gateway';
import { SageCore } from './core';

class FakeAgentProvider implements AgentProvider {
  readonly name = 'fake-agent';
  private sessionCounter = 1;
  private sessions = new Map<string, AgentSession>();
  readonly receivedMessages: Array<{ sessionId: string; message: string }> = [];

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

const tempDirs: string[] = [];
const originalRestartEnv = {
  OWNER_OPEN_ID: process.env.OWNER_OPEN_ID,
  name: process.env.name,
  SAGE_INSTANCE: process.env.SAGE_INSTANCE,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv('OWNER_OPEN_ID', originalRestartEnv.OWNER_OPEN_ID);
  restoreEnv('name', originalRestartEnv.name);
  restoreEnv('SAGE_INSTANCE', originalRestartEnv.SAGE_INSTANCE);
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
});
