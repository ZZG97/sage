// Agent 层入口 — 工厂函数 + 导出

import { AgentProvider, AgentProviderConfig } from './types';
import { OpenCodeProvider } from './opencode-provider';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CodexProvider } from './codex-provider';

export type { AgentProvider, AgentSession, AgentResponse, AgentProviderConfig } from './types';
export { OpenCodeProvider } from './opencode-provider';
export { ClaudeCodeProvider } from './claude-code-provider';
export { CodexProvider } from './codex-provider';

/**
 * 根据配置创建 AgentProvider 实例
 */
export function createAgentProvider(config: AgentProviderConfig): AgentProvider {
  switch (config.type) {
    case 'opencode':
      return new OpenCodeProvider(config);
    case 'claude-code':
      return new ClaudeCodeProvider(config);
    case 'codex':
      return new CodexProvider(config);
    default:
      throw new Error(`未知的 agent provider 类型: ${(config as any).type}`);
  }
}
