// Agent 抽象层类型定义

// Agent 会话
export interface AgentSession {
  id: string;
  provider: string; // 哪个 provider 创建的
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>; // provider 特有的数据
}

// Agent 回复
export interface AgentResponse {
  text: string;
  // 预留：未来支持富文本、工具调用结果等
  metadata?: Record<string, unknown>;
}

// Agent Provider 接口 — 所有底层实现必须满足
export interface AgentProvider {
  /** provider 名称，如 'opencode', 'claude-code' */
  readonly name: string;

  /** 初始化（连接检查等） */
  initialize(): Promise<void>;

  /** 健康检查 */
  healthCheck(): Promise<boolean>;

  /** 创建新会话 */
  createSession(): Promise<AgentSession>;

  /** 发送消息并获取回复 */
  sendMessage(sessionId: string, message: string): Promise<AgentResponse>;

  /** 删除会话 */
  deleteSession(sessionId: string): Promise<void>;

  /** 获取所有活跃会话 */
  getActiveSessions(): AgentSession[];

  /** 清理过期会话 */
  cleanupSessions(maxAgeMs: number): Promise<number>;

  /** 销毁 provider（释放资源） */
  destroy(): Promise<void>;
}

// Provider 配置
export interface OpenCodeProviderConfig {
  type: 'opencode';
  baseUrl: string;
}

export interface ClaudeCodeProviderConfig {
  type: 'claude-code';
  workDir?: string; // Claude Code 工作目录
  maxTurns?: number; // 最大交互轮数，默认 25
  allowedTools?: string[]; // 允许的工具列表
  model?: string; // 模型，如 'sonnet', 'opus'
}

export type AgentProviderConfig = OpenCodeProviderConfig | ClaudeCodeProviderConfig;
