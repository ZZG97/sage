import * as Lark from '@larksuiteoapi/node-sdk';
import { BaseConfig, FeishuMessage, FeishuTextContent, MessageContext } from '../types';
import { Logger, AppError } from '../utils';

export class FeishuService {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private eventDispatcher: Lark.EventDispatcher;
  private logger: Logger;
  private messageHandler?: (ctx: MessageContext) => Promise<string>;
  private threadCreatedHandler?: (messageId: string, threadId: string) => void;
  private processedMessages: Set<string> = new Set(); // 消息去重
  // 记录 message_id -> thread_id 的映射（当新消息回复后产生 thread）
  private messageThreadMap: Map<string, string> = new Map();

  constructor(config: BaseConfig) {
    this.logger = new Logger('FeishuService');

    this.client = new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
    });

    this.wsClient = new Lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
    });

    this.eventDispatcher = new Lark.EventDispatcher({});
    this.setupEventHandlers();
  }

  // 设置消息处理器
  setMessageHandler(handler: (ctx: MessageContext) => Promise<string>) {
    this.messageHandler = handler;
  }

  // 设置 thread 创建回调（回复后飞书产生 thread_id 时通知调用方）
  setThreadCreatedHandler(handler: (messageId: string, threadId: string) => void) {
    this.threadCreatedHandler = handler;
  }

  // 设置事件处理器
  private setupEventHandlers() {
    this.eventDispatcher
      .register({
        'im.message.receive_v1': async (data: any) => {
          await this.handleMessage(data as FeishuMessage);
        },
      })
      .register({
        'connection': async (data: any) => {
          this.logger.info('长连接状态变更:', data);
        },
      });
  }

  // 处理接收到的消息
  private async handleMessage(data: FeishuMessage): Promise<void> {
    const { message, sender, event_id } = data as any;
    this.logger.info('收到消息事件:', JSON.stringify(data, null, 2));

    try {
      // 消息去重检查
      if (this.isDuplicateMessage(event_id)) {
        this.logger.warn(`检测到重复消息，事件ID: ${event_id}，跳过处理`);
        return;
      }

      // 解析消息内容
      const messageText = this.parseMessageContent(message);
      if (!messageText) {
        this.logger.warn('无法解析消息内容');
        return;
      }

      // 提取发送者 open_id
      const openId = sender?.sender_id?.open_id || 'unknown';

      // 提取 thread_id
      const threadId = message.thread_id || undefined;

      this.logger.info(`用户消息: text="${messageText}", openId=${openId}, threadId=${threadId || '无'}, messageId=${message.message_id}`);

      // 立即回复一个表情，表示已收到消息
      this.addReaction(message.message_id, 'THUMBSUP').catch(err => {
        this.logger.warn('添加表情回复失败:', err);
      });

      // 构建消息上下文
      const ctx: MessageContext = {
        text: messageText,
        openId,
        chatId: message.chat_id,
        messageId: message.message_id,
        chatType: message.chat_type,
        threadId,
        rootId: message.root_id || undefined,
      };

      // 如果没有设置消息处理器，使用默认回复
      let responseText: string;
      if (this.messageHandler) {
        responseText = await this.messageHandler(ctx);
      } else {
        responseText = `收到你发送的消息: ${messageText}`;
      }

      // 发送回复并获取回复中的 thread_id
      await this.sendReply(message, responseText);

    } catch (error) {
      this.logger.error('处理消息失败:', error);

      // 发送错误回复
      try {
        await this.sendReply(message, '抱歉，处理消息时出现错误，请稍后再试');
      } catch (replyError) {
        this.logger.error('发送错误回复失败:', replyError);
      }
    }
  }

  // 解析消息内容
  private parseMessageContent(message: FeishuMessage['message']): string | null {
    try {
      if (message.message_type === 'text') {
        const content = JSON.parse(message.content) as FeishuTextContent;
        return content.text;
      }
      return null;
    } catch (error) {
      this.logger.error('解析消息内容失败:', error);
      return null;
    }
  }

  // 发送回复消息
  private async sendReply(message: FeishuMessage['message'], responseText: string): Promise<void> {
    try {
      // 统一以话题形式回复，确保 thread 上下文隔离
      const response = await this.client.im.v1.message.reply({
        path: {
          message_id: message.message_id,
        },
        data: {
          content: JSON.stringify({ text: responseText }),
          msg_type: 'text',
          reply_in_thread: true,
        },
      });

      // 从回复响应中提取 thread_id，保存映射关系
      const replyData = response?.data as any;
      if (replyData?.thread_id) {
        this.messageThreadMap.set(message.message_id, replyData.thread_id);
        this.logger.info(`记录 thread 映射: ${message.message_id} -> ${replyData.thread_id}`);
        // 通知调用方，让 SageCore 迁移 session
        this.threadCreatedHandler?.(message.message_id, replyData.thread_id);
      }

      this.logger.info(`回复发送成功 (chat_type: ${message.chat_type})`);
    } catch (error) {
      throw new AppError('发送回复消息失败', 'SEND_REPLY_FAILED');
    }
  }

  // 给消息添加表情回复
  async addReaction(messageId: string, emojiType: string): Promise<void> {
    try {
      await this.client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      this.logger.info(`表情回复已添加: ${emojiType} -> ${messageId}`);
    } catch (error) {
      this.logger.error('添加表情回复失败:', error);
    }
  }

  // 发送文本消息（对外接口）
  async sendTextMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      this.logger.info(`消息发送成功到聊天 ${chatId}`);
    } catch (error) {
      throw new AppError('发送消息失败', 'SEND_MESSAGE_FAILED');
    }
  }

  // 获取 message_id 对应的 thread_id
  getThreadIdByMessageId(messageId: string): string | undefined {
    return this.messageThreadMap.get(messageId);
  }

  // 启动WebSocket连接
  async start(): Promise<void> {
    try {
      this.logger.info('正在启动飞书服务...');
      await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      this.logger.info('飞书服务启动成功');
    } catch (error) {
      throw new AppError('启动飞书服务失败', 'START_SERVICE_FAILED');
    }
  }

  // 停止WebSocket连接
  async stop(): Promise<void> {
    try {
      this.logger.info('正在停止飞书服务...');
      (this.wsClient as any).stop?.();
      this.logger.info('飞书服务已停止');
    } catch (error) {
      this.logger.error('停止飞书服务失败:', error);
    }
  }

  // 获取用户信息
  async getUserInfo(userId: string): Promise<any> {
    try {
      const response = await this.client.contact.v3.user.get({
        path: { user_id: userId },
      });
      return response.data;
    } catch (error) {
      throw new AppError('获取用户信息失败', 'GET_USER_INFO_FAILED');
    }
  }

  // 获取聊天信息
  async getChatInfo(chatId: string): Promise<any> {
    try {
      const response = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      return response.data;
    } catch (error) {
      throw new AppError('获取聊天信息失败', 'GET_CHAT_INFO_FAILED');
    }
  }

  // 检查消息是否重复
  private isDuplicateMessage(eventId: string): boolean {
    if (this.processedMessages.has(eventId)) {
      return true;
    }

    this.processedMessages.add(eventId);

    if (this.processedMessages.size > 1000) {
      this.cleanupProcessedMessages();
    }

    return false;
  }

  // 清理过期的已处理消息
  private cleanupProcessedMessages(): void {
    const entries = Array.from(this.processedMessages.entries());
    const toKeep = entries.slice(-500);
    this.processedMessages.clear();
    toKeep.forEach(([eventId]) => this.processedMessages.add(eventId));

    this.logger.info(`清理已处理消息，保留最近 ${toKeep.length} 个`);

    // 同时清理过旧的 thread 映射
    if (this.messageThreadMap.size > 1000) {
      const threadEntries = Array.from(this.messageThreadMap.entries());
      const threadToKeep = threadEntries.slice(-500);
      this.messageThreadMap.clear();
      threadToKeep.forEach(([k, v]) => this.messageThreadMap.set(k, v));
      this.logger.info(`清理 thread 映射，保留最近 ${threadToKeep.length} 个`);
    }
  }
}
