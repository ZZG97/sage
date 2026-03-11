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
    thread_id?: string; // 话题ID，omt_ 开头
    root_id?: string; // 根消息ID（回复场景）
    parent_id?: string; // 父消息ID（回复场景）
  };
  sender?: {
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
}

export interface FeishuTextContent {
  text: string;
}

// 消息上下文 - 传递给消息处理器的完整上下文
export interface MessageContext {
  text: string; // 消息文本内容
  openId: string; // 发送者的 open_id
  chatId: string; // 聊天ID
  messageId: string; // 消息ID
  chatType: 'p2p' | 'group'; // 聊天类型
  threadId?: string; // 话题ID（如果在话题中回复）
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