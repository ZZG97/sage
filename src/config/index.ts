import { AppConfig } from '../types';
import { AgentProviderConfig } from '../agent';

export const appConfig: AppConfig = {
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    domain: process.env.FEISHU_DOMAIN || 'https://open.feishu.cn',
  },
  opencode: {
    baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4111',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
  },
};

/**
 * 根据环境变量构建 AgentProvider 配置
 * AGENT_PROVIDER: 'opencode' | 'claude-code' | 'codex'，默认 'opencode'
 */
export function getAgentConfig(): AgentProviderConfig {
  const provider = process.env.AGENT_PROVIDER || 'opencode';

  switch (provider) {
    case 'claude-code':
      return {
        type: 'claude-code',
        workDir: process.env.CLAUDE_CODE_WORK_DIR,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
      };

    case 'cc-minimax':
      return {
        type: 'cc-minimax',
        workDir: process.env.CLAUDE_CODE_WORK_DIR,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CC_MINIMAX_MODEL || 'MiniMax-M2.7',
        apiKey: process.env.CC_MINIMAX_API_KEY || '',
        baseUrl: process.env.CC_MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic',
        tavilyApiKey: process.env.TAVILY_API_KEY || '',
      };

    case 'codex':
      return {
        type: 'codex',
        workDir: process.env.CODEX_WORK_DIR,
        model: process.env.CODEX_MODEL || 'gpt-5.3-codex',
        sandboxMode: (process.env.CODEX_SANDBOX_MODE as any) || 'danger-full-access',
      };

    case 'opencode':
    default:
      return {
        type: 'opencode',
        baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4111',
      };
  }
}

/**
 * 获取 fallback provider 配置（如果设置了 AGENT_FALLBACK_PROVIDER）
 */
export function getFallbackAgentConfig(): AgentProviderConfig | null {
  const provider = process.env.AGENT_FALLBACK_PROVIDER;
  if (!provider) return null;

  switch (provider) {
    case 'claude-code':
      return {
        type: 'claude-code',
        workDir: process.env.CLAUDE_CODE_WORK_DIR,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
      };

    case 'cc-minimax':
      return {
        type: 'cc-minimax',
        workDir: process.env.CLAUDE_CODE_WORK_DIR,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CC_MINIMAX_MODEL || 'MiniMax-M2.7',
        apiKey: process.env.CC_MINIMAX_API_KEY || '',
        baseUrl: process.env.CC_MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic',
        tavilyApiKey: process.env.TAVILY_API_KEY || '',
      };

    case 'codex':
      return {
        type: 'codex',
        workDir: process.env.CODEX_WORK_DIR,
        model: process.env.CODEX_MODEL || 'gpt-5.3-codex',
        sandboxMode: (process.env.CODEX_SANDBOX_MODE as any) || 'danger-full-access',
      };

    case 'opencode':
      return {
        type: 'opencode',
        baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4111',
      };

    default:
      return null;
  }
}

// 配置验证
export function validateConfig(): boolean {
  const requiredEnvVars = [
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
  ];

  const missing = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missing.length > 0) {
    console.error('缺少必需的环境变量:', missing.join(', '));
    return false;
  }

  return true;
}
