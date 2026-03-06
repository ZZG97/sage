import * as Lark from '@larksuiteoapi/node-sdk';
import { BaseConfig, FeishuMessage, FeishuTextContent, MessageHandlerResult } from '../types';
import { Logger, AppError } from '../utils';

export class FeishuService {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private eventDispatcher: Lark.EventDispatcher;
  private logger: Logger;
  private messageHandler?: (message: string) => Promise<string>;
  private processedMessages: Set<string> = new Set(); // 消息去重
  private messageTimeout = 5 * 60 * 1000; // 5分钟超时

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
  setMessageHandler(handler: (message: string) => Promise<string>) {
    this.messageHandler = handler;
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
    const { message, event_id } = data as any;
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

      this.logger.info(`用户消息内容: ${messageText}`);

      // 如果没有设置消息处理器，使用默认回复
      let responseText: string;
      if (this.messageHandler) {
        responseText = await this.messageHandler(messageText);
      } else {
        responseText = `收到你发送的消息: ${messageText}`;
      }

      // 发送回复
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
      if (message.chat_type === 'p2p') {
        // 单聊
        await this.client.im.v1.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: message.chat_id,
            content: JSON.stringify({ text: responseText }),
            msg_type: 'text',
          },
        });
        this.logger.info('单聊回复发送成功');
      } else {
        // 群聊
        await this.client.im.v1.message.reply({
          path: {
            message_id: message.message_id,
          },
          data: {
            content: JSON.stringify({ text: responseText }),
            msg_type: 'text',
          },
        });
        this.logger.info('群聊回复发送成功');
      }
    } catch (error) {
      throw new AppError('发送回复消息失败', 'SEND_REPLY_FAILED');
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
      // 注意：WebSocket客户端的停止方法可能需要根据实际SDK调整
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

    // 添加到已处理消息集合
    this.processedMessages.add(eventId);

    // 定期清理过期的消息ID（防止内存泄漏）
    if (this.processedMessages.size > 1000) {
      this.cleanupProcessedMessages();
    }

    return false;
  }

  // 清理过期的已处理消息
  private cleanupProcessedMessages(): void {
    // 这里可以添加更复杂的清理逻辑，比如基于时间的清理
    // 目前简单限制集合大小
    const entries = Array.from(this.processedMessages.entries());
    const toKeep = entries.slice(-500); // 保留最近500个
    this.processedMessages.clear();
    toKeep.forEach(([eventId]) => this.processedMessages.add(eventId));
    
    this.logger.info(`清理已处理消息，保留最近 ${toKeep.length} 个`);
  }
}