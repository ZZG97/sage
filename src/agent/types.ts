// Agent 抽象层类型定义

// Agent 会话
export interface AgentSession {
  id: string;
  provider: string; // 哪个 provider 创建的
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>; // provider 特有的数据
}

// Agent 事件 — provider 在处理过程中产生的各类事件
export interface AgentEvent {
  type: string;           // text / tool_call / tool_result / error / 或 provider 自定义
  content?: string;       // 文本内容 或 摘要
  toolName?: string;      // type=tool_call 时的工具名
  toolDetail?: string;    // diff / command 等详情（JSON）
  ts: string;             // ISO 时间戳
  persist: boolean;       // 是否需要持久化到历史记录
}

// Agent 回复
export interface AgentResponse {
  text: string;
  events: AgentEvent[];   // 处理过程中产生的事件流
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
