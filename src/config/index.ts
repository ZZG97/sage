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
 * AGENT_PROVIDER: 'opencode' | 'claude-code'，默认 'opencode'
 */
export function getAgentConfig(): AgentProviderConfig {
  const provider = process.env.AGENT_PROVIDER || 'opencode';

  switch (provider) {
    case 'claude-code':
      return {
        type: 'claude-code',
        // 默认指向 agent_home，让小克共享身份和记忆
        workDir: process.env.CLAUDE_CODE_WORK_DIR || `${process.env.HOME}/workspace/agent_home`,
        maxTurns: parseInt(process.env.CLAUDE_CODE_MAX_TURNS || '30', 10),
        allowedTools: process.env.CLAUDE_CODE_ALLOWED_TOOLS?.split(',').filter(Boolean),
        model: process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
      };

    case 'opencode':
    default:
      return {
        type: 'opencode',
        baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4111',
      };
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
