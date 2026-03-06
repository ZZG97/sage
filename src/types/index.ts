// 基础类型定义
export interface BaseConfig {
  appId: string;
  appSecret: string;
  domain: string;
}

// 飞书相关类型
export interface FeishuMessage {
  message: {
    chat_id: string;
    content: string;
    message_type: string;
    chat_type: 'p2p' | 'group';
    message_id: string;
  };
}

export interface FeishuTextContent {
  text: string;
}

// OpenCode 相关类型
export interface OpenCodeSession {
  id: string;
  created_at?: string;
  updated_at?: string;
}

export interface OpenCodePromptRequest {
  parts: Array<{
    type: 'text';
    text: string;
  }>;
}

export interface OpenCodePromptResponse {
  data?: {
    response?: string;
    // 根据实际API响应结构定义
  };
}

// 应用配置类型
export interface AppConfig {
  feishu: {
    appId: string;
    appSecret: string;
    domain: string;
  };
  opencode: {
    baseUrl: string;
  };
  server: {
    port: number;
    host: string;
  };
}

// 消息处理结果
export interface MessageHandlerResult {
  success: boolean;
  response?: string;
  error?: string;
}