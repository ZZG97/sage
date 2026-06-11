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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createCoreHarness(): {
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
  const core = new SageCore(agent, historyStore, gateway);
  return {
    core,
    agent,
    historyStore,
    gateway,
    destroy: () => historyStore.destroy(),
  };
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
});
