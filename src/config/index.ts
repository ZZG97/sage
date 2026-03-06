import { config } from 'dotenv';
import { AppConfig } from '../types';

// 加载环境变量
config();

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