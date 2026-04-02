// Agent 层入口 — 工厂函数 + 导出

import { AgentProvider, AgentProviderConfig } from './types';
import { OpenCodeProvider } from './opencode-provider';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CodexProvider } from './codex-provider';
import { CcMinimaxProvider } from './cc-minimax-provider';
import { FallbackAgentProvider } from './fallback-provider';

export type { AgentProvider, AgentSession, AgentResponse, AgentEvent, AgentProviderConfig } from './types';
export { OpenCodeProvider } from './opencode-provider';
export { ClaudeCodeProvider } from './claude-code-provider';
export { CodexProvider } from './codex-provider';
export { CcMinimaxProvider } from './cc-minimax-provider';
export { FallbackAgentProvider } from './fallback-provider';

/**
 * 创建单个 AgentProvider 实例
 */
function createSingleProvider(config: AgentProviderConfig): AgentProvider {
  switch (config.type) {
    case 'opencode':
      return new OpenCodeProvider(config);
    case 'claude-code':
      return new ClaudeCodeProvider(config);
    case 'codex':
      return new CodexProvider(config);
    case 'cc-minimax':
      return new CcMinimaxProvider(config);
    default:
      throw new Error(`未知的 agent provider 类型: ${(config as any).type}`);
  }
}

/**
 * 根据配置创建 AgentProvider 实例
 * - 单个 config → 直接返回 provider
 * - 多个 configs → 包装为 FallbackAgentProvider（第一个为默认活跃）
 */
export function createAgentProvider(configs: AgentProviderConfig[]): AgentProvider {
  if (configs.length === 0) {
    throw new Error('至少需要一个 provider 配置');
  }
  if (configs.length === 1) {
    return createSingleProvider(configs[0]);
  }
  const providers = configs.map(c => createSingleProvider(c));
  return new FallbackAgentProvider(providers);
}
