import type { AppConfig } from '../types';
import { AgentProviderConfig } from '../agent';

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

const httpAuthTokens = uniqueNonEmpty([
  process.env.SAGE_HTTP_TOKEN,
  process.env.SAGE_INTERNAL_HTTP_TOKEN,
]);

export const DEFAULT_HTTP_HOST = '127.0.0.1';

interface HttpExposureRuntimeEnv {
  NODE_ENV?: string;
  SAGE_INSTANCE?: string;
  PROCESS_NAME?: string;
}

function isHttpAuthConfiguredForStartup(auth: AppConfig['server']['auth']): boolean {
  return auth.tokens.length > 0;
}

function isHttpAuthEnabledForStartup(auth: AppConfig['server']['auth']): boolean {
  return auth.required || isHttpAuthConfiguredForStartup(auth);
}

export function isProductionRuntime(env: HttpExposureRuntimeEnv = process.env): boolean {
  if (env.SAGE_INSTANCE === 'sage' || env.PROCESS_NAME === 'sage') return true;
  if (env.SAGE_INSTANCE === 'sage-dev' || env.PROCESS_NAME === 'sage-dev') return false;
  return env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test';
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  const unbracketed = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized;

  return unbracketed === 'localhost'
    || unbracketed === '::1'
    || unbracketed === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(unbracketed);
}

export function getHttpServerExposureError(
  server: AppConfig['server'],
  env: HttpExposureRuntimeEnv = process.env,
): string | null {
  const authConfigured = isHttpAuthConfiguredForStartup(server.auth);

  if (server.auth.required && !authConfigured) {
    return 'SAGE_HTTP_AUTH_REQUIRED is enabled but no SAGE_HTTP_TOKEN or SAGE_INTERNAL_HTTP_TOKEN is configured';
  }

  if (!isProductionRuntime(env) || isLoopbackHost(server.host)) {
    return null;
  }

  if (!isHttpAuthEnabledForStartup(server.auth) || !authConfigured) {
    return `Refusing to start production HTTP server on non-loopback host ${server.host} without Sage HTTP auth token`;
  }

  return null;
}

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
    host: process.env.HOST || DEFAULT_HTTP_HOST,
    auth: {
      required: parseBooleanEnv(process.env.SAGE_HTTP_AUTH_REQUIRED, httpAuthTokens.length > 0),
      tokens: httpAuthTokens,
      cookieName: process.env.SAGE_HTTP_AUTH_COOKIE || 'sage_http_token',
    },
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
        minimaxMcp: process.env.MINIMAX_API_KEY ? {
          apiKey: process.env.MINIMAX_API_KEY,
          basePath: process.env.MINIMAX_MCP_BASE_PATH || '',
          apiHost: process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com',
          resourceMode: (process.env.MINIMAX_API_RESOURCE_MODE as 'url' | 'local') || 'url',
        } : undefined,
      };

    case 'codex':
      return {
        type: 'codex',
        workDir: process.env.CODEX_WORK_DIR,
        model: process.env.CODEX_MODEL || 'gpt-5.3-codex',
        reasoningEffort: process.env.CODEX_REASONING_EFFORT as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined,
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

  const httpExposureError = getHttpServerExposureError(appConfig.server);
  if (httpExposureError) {
    console.error('HTTP 服务配置不安全:', httpExposureError);
    return false;
  }

  return true;
}
