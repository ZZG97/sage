import { createOpencodeClient } from '@opencode-ai/sdk';
import { OpenCodeSession, OpenCodePromptRequest, OpenCodePromptResponse } from '../types';
import { Logger, AppError } from '../utils';

export class OpenCodeService {
  private client: ReturnType<typeof createOpencodeClient>;
  private logger: Logger;
  private sessions: Map<string, OpenCodeSession> = new Map();

  constructor(baseUrl: string) {
    this.logger = new Logger('OpenCodeService');
    this.client = createOpencodeClient({ baseUrl });
  }

  // 创建新的会话
  async createSession(): Promise<OpenCodeSession> {
    try {
      this.logger.info('创建新的OpenCode会话');
      const response = await this.client.session.create({});
      
      if (!response.data?.id) {
        throw new AppError('创建会话失败：没有返回会话ID', 'CREATE_SESSION_FAILED');
      }

      const session: OpenCodeSession = {
        id: response.data.id,
        // 根据实际API响应结构调整
        created_at: (response.data as any).created_at,
        updated_at: (response.data as any).updated_at,
      };

      // 保存会话到内存中
      this.sessions.set(session.id, session);
      this.logger.info(`会话创建成功: ${session.id}`);
      
      return session;
    } catch (error) {
      this.logger.error('创建OpenCode会话失败:', error);
      throw new AppError('创建会话失败', 'CREATE_SESSION_FAILED');
    }
  }

  // 获取或创建会话
  async getOrCreateSession(sessionId?: string): Promise<OpenCodeSession> {
    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      this.logger.info(`使用现有会话: ${sessionId}`);
      return session;
    }

    // 创建新会话
    return await this.createSession();
  }

  // 发送消息到OpenCode
  async sendMessage(sessionId: string, message: string): Promise<string> {
    try {
      this.logger.info(`向会话 ${sessionId} 发送消息: ${message}`);
      
      const promptRequest: OpenCodePromptRequest = {
        parts: [{ type: 'text', text: message }],
      };

      const response = await this.client.session.prompt({
        body: promptRequest,
        path: { id: sessionId },
      });

      if (!response.data) {
        throw new AppError('OpenCode响应为空', 'EMPTY_RESPONSE');
      }

      // 根据实际API响应结构调整
      const responseText = this.extractResponseText(response.data);
      this.logger.info(`收到OpenCode回复: ${responseText}`);
      
      return responseText;
    } catch (error) {
      this.logger.error('发送消息到OpenCode失败:', error);
      
      if (error instanceof AppError) {
        throw error;
      }
      
      throw new AppError('发送消息失败', 'SEND_MESSAGE_FAILED');
    }
  }

  // 提取响应文本
  private extractResponseText(data: any): string {
    try {
      // 根据实际API响应结构调整
      if (typeof data === 'string') {
        return data;
      }
      
      // 处理OpenCode的响应格式
      if (data.parts && Array.isArray(data.parts)) {
        // 从parts数组中提取文本内容
        const textParts = data.parts.filter((part: any) => part.type === 'text');
        if (textParts.length > 0) {
          return textParts.map((part: any) => part.text).join('\n');
        }
      }
      
      if (data.response) {
        return data.response;
      }
      
      if (data.text) {
        return data.text;
      }
      
      // 如果无法提取，返回默认消息
      return '抱歉，无法解析AI回复内容';
    } catch (error) {
      this.logger.error('提取响应文本失败:', error);
      return '抱歉，处理AI回复时出现错误';
    }
  }

  // 删除会话
  async deleteSession(sessionId: string): Promise<void> {
    try {
      this.logger.info(`删除会话: ${sessionId}`);
      
      // 从内存中删除
      this.sessions.delete(sessionId);
      
      // 调用API删除会话（如果支持）
      try {
        // 注意：这里需要根据实际的OpenCode API来实现
        // await this.client.session.delete({ path: { id: sessionId } });
      } catch (apiError) {
        this.logger.warn(`调用API删除会话失败: ${sessionId}`, apiError);
      }
      
      this.logger.info(`会话已删除: ${sessionId}`);
    } catch (error) {
      this.logger.error('删除会话失败:', error);
      throw new AppError('删除会话失败', 'DELETE_SESSION_FAILED');
    }
  }

  // 获取所有会话
  getAllSessions(): OpenCodeSession[] {
    return Array.from(this.sessions.values());
  }

  // 清理过期会话
  cleanupExpiredSessions(maxAge: number = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const sessionAge = now - new Date(session.created_at || now).getTime();
      
      if (sessionAge > maxAge) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.info(`清理了 ${cleaned} 个过期会话`);
    }

    return cleaned;
  }

  // 健康检查
  async healthCheck(): Promise<boolean> {
    try {
      // 尝试获取会话列表来检查服务状态
      const sessions = await this.client.session.list();
      return sessions.data !== undefined;
    } catch (error) {
      this.logger.error('OpenCode服务健康检查失败:', error);
      return false;
    }
  }
}