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
  processName: process.env.PROCESS_NAME || 'sage',
};

/** 所有支持的 provider 类型 */
export const ALL_PROVIDER_TYPES = ['claude-code', 'cc-minimax', 'codex', 'opencode'] as const;
export type ProviderType = typeof ALL_PROVIDER_TYPES[number];

/**
 * 根据类型构建单个 provider 配置
 */
export function getProviderConfig(type: string): AgentProviderConfig | null {
  switch (type) {
    case 'claude-code':
      return {
        type: 'claude-code',
        workDir: process.env.CLAUDE_CODE_WORK_DIR,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
      };

    case 'cc-minimax':
      if (!process.env.CC_MINIMAX_API_KEY) return null;
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

/**
 * 获取主 provider 配置（AGENT_PROVIDER 环境变量）
 */
export function getAgentConfig(): AgentProviderConfig {
  const provider = process.env.AGENT_PROVIDER || 'opencode';
  const config = getProviderConfig(provider);
  if (!config) {
    throw new Error(`主 provider ${provider} 配置不完整，请检查环境变量`);
  }
  return config;
}

/**
 * 获取所有可用的 provider 配置（有完整 env var 的）
 * 返回顺序：主 provider 在最前
 */
export function getAllAvailableProviderConfigs(primaryType: string): AgentProviderConfig[] {
  const configs: AgentProviderConfig[] = [];
  const seen = new Set<string>();

  // 主 provider 排第一
  const primaryConfig = getProviderConfig(primaryType);
  if (primaryConfig) {
    configs.push(primaryConfig);
    seen.add(primaryType);
  }

  // 其余可用的 provider
  for (const type of ALL_PROVIDER_TYPES) {
    if (seen.has(type)) continue;
    const config = getProviderConfig(type);
    if (config) {
      configs.push(config);
      seen.add(type);
    }
  }

  return configs;
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
