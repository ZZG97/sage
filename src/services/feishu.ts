import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { BaseConfig, FeishuMessage, FeishuTextContent, MessageContext, MessageAttachment } from '../types';
import type { AgentEvent } from '../agent/types';
import { createRequestId, Logger, AppError, runWithRequestContext, sanitizeLogValue } from '../utils';
import type {
  AssistantResponder,
  AssistantResponseResult,
  AssistantResponseSnapshot,
  MessageGateway,
  ResponseAnchor,
  ResponseBinding,
} from './message-gateway';
import {
  buildErrorCard as renderErrorCard,
  buildStreamingCard as renderStreamingCard,
  CARD_SIZE_LIMIT,
  FENCED_CODE_BLOCK_REGEX,
  hasTooManyMarkdownTables,
  isRemoteImageSource,
  MARKDOWN_IMAGE_REGEX,
  splitMarkdownByTables,
} from './card-renderer';

export {
  CARD_SIZE_LIMIT,
  splitMarkdownByTables,
} from './card-renderer';

// 上传目录（相对于 agent_home）
const AGENT_HOME_DIR = path.resolve(process.env.HOME || '', 'workspace/sage/agent_home');
const UPLOADS_DIR = path.join(AGENT_HOME_DIR, 'workspace/uploads');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const FILES_DIR = path.join(UPLOADS_DIR, 'files');

export class FeishuService implements MessageGateway {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private eventDispatcher: Lark.EventDispatcher;
  private logger: Logger;
  private messageHandler?: (ctx: MessageContext) => Promise<void>;
  private messageRecallHandler?: (messageId: string) => Promise<void> | void;
  private processedMessages: Set<string> = new Set();
  private messageThreadMap: Map<string, string> = new Map();
  private dbDedupFn?: (eventId: string) => boolean;
  // PATCH 失败的消息 ID，后续不再尝试更新
  private failedPatchMessages: Set<string> = new Set();

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

    // 确保上传目录存在
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
    fs.mkdirSync(FILES_DIR, { recursive: true });
  }

  // ─── 消息处理器注册 ───

  setMessageHandler(handler: (ctx: MessageContext) => Promise<void>) {
    this.messageHandler = handler;
  }

  setMessageRecallHandler(handler: (messageId: string) => Promise<void> | void) {
    this.messageRecallHandler = handler;
  }

  /** 注入 DB 去重函数（HistoryStore.isDuplicateEvent），重启后兜底 */
  setDedupFn(fn: (eventId: string) => boolean) {
    this.dbDedupFn = fn;
  }

  createResponder(anchor: ResponseAnchor): AssistantResponder {
    return new FeishuAssistantResponder(this, anchor);
  }

  // ─── 事件处理 ───

  private setupEventHandlers() {
    this.eventDispatcher
      .register({
        'im.message.receive_v1': async (data: any) => {
          // Feishu long-connection handlers should ACK quickly.
          // Full agent processing can exceed Feishu's retry threshold, so run it in background.
          this.handleMessage(data as FeishuMessage).catch((err) => {
            this.logger.error('异步处理消息失败:', err);
          });
        },
        'im.message.recalled_v1': async (data: any) => {
          this.handleMessageRecall(data).catch((err) => {
            this.logger.error('异步处理消息撤回失败:', err);
          });
        },
        'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {
          this.logger.debug('忽略飞书 bot_p2p_chat_entered 事件');
        },
      })
      .register({
        'connection': async (data: any) => {
          this.logger.info('长连接状态变更:', data);
        },
      });
  }

  private async handleMessageRecall(data: any): Promise<void> {
    const eventId = data?.event_id || data?.header?.event_id;
    if (eventId && this.isDuplicateMessage(eventId)) {
      this.logger.warn(`检测到重复撤回事件，事件ID: ${eventId}，跳过处理`);
      return;
    }

    const messageId =
      data?.message_id
      || data?.message?.message_id
      || data?.event?.message_id
      || data?.event?.message?.message_id;

    if (!messageId) {
      this.logger.warn('收到消息撤回事件但无 message_id:', data);
      return;
    }

    this.logger.info(`消息已撤回: messageId=${messageId}`);
    if (this.messageRecallHandler) {
      await this.messageRecallHandler(messageId);
    }
  }

  private async handleMessage(data: FeishuMessage): Promise<void> {
    const { message, sender, event_id } = data as any;

    return runWithRequestContext({
      requestId: createRequestId('msg'),
      source: 'feishu',
      messageId: message?.message_id,
    }, async () => {
      this.logger.debug('收到消息事件 raw:', data);

      try {
        if (this.isDuplicateMessage(event_id)) {
          this.logger.warn(`检测到重复消息，事件ID: ${event_id}，跳过处理`);
          return;
        }

        // 解析消息内容（支持 text/image/file/post）
        const parsed = await this.parseMessageContent(message);
        if (!parsed) {
          this.logger.warn('无法解析消息内容，类型:', message.message_type);
          return;
        }

        const openId = sender?.sender_id?.open_id || 'unknown';
        const threadId = message.thread_id || undefined;
        const textPreview = sanitizeLogValue(parsed.text, 100);

        this.logger.info(
          `用户消息: type=${message.message_type}, event=${event_id}, open=${openId}, thread=${threadId || '无'}, textLen=${parsed.text.length}, preview="${textPreview}"`
        );

        // 立即回复表情
        this.addReaction(message.message_id, 'THUMBSUP').catch(err => {
          this.logger.warn('添加表情回复失败:', err);
        });

        const ctx: MessageContext = {
          text: parsed.text,
          openId,
          chatId: message.chat_id,
          messageId: message.message_id,
          chatType: message.chat_type,
          threadId,
          rootId: message.root_id || undefined,
          parentId: message.parent_id || undefined,
          attachments: parsed.attachments,
        };

        // SageCore 自行控制卡片生命周期（不再返回 string）
        if (this.messageHandler) {
          await this.messageHandler(ctx);
        }

      } catch (error) {
        this.logger.error('处理消息失败:', error);
        try {
          await this.replyCard(message.message_id, this.buildErrorCard('抱歉，处理消息时出现错误，请稍后再试'));
        } catch (replyError) {
          this.logger.error('发送错误回复失败:', replyError);
        }
      }
    });
  }

  // ─── 消息解析（Phase 1）───

  private async parseMessageContent(message: FeishuMessage['message']): Promise<{ text: string; attachments?: MessageAttachment[] } | null> {
    try {
      const content = JSON.parse(message.content);

      switch (message.message_type) {
        case 'text':
          return { text: (content as FeishuTextContent).text };

        case 'image': {
          const fileKey = content.image_key as string;
          const localPath = await this.downloadMessageResource(message.message_id, fileKey, undefined, 'image');
          return {
            text: `![user_uploaded_image](${localPath})`,
            attachments: [{ type: 'image', path: localPath }],
          };
        }

        case 'file': {
          const fileKey = content.file_key as string;
          const fileName = content.file_name as string;
          const localPath = await this.downloadMessageResource(message.message_id, fileKey, fileName);
          return {
            text: `用户上传了文件: \`${localPath}\``,
            attachments: [{ type: 'file', path: localPath, name: fileName }],
          };
        }

        case 'post': {
          const result = await this.convertPostToMarkdown(message.message_id, content);
          return { text: result.text, attachments: result.attachments };
        }

        default:
          this.logger.warn(`不支持的消息类型: ${message.message_type}`);
          return null;
      }
    } catch (error) {
      this.logger.error('解析消息内容失败:', error);
      return null;
    }
  }

  /** 下载飞书消息中的图片/文件资源 */
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    fileName?: string,
    resourceType: 'file' | 'image' = 'file',
  ): Promise<string> {
    const response = await this.client.im.v1.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: resourceType,
      },
    });

    // 解析文件元数据
    const metaHeader = (response as any).headers?.get?.('inner_file_data_meta')
      || (response as any).headers?.['inner_file_data_meta'];
    let mime = 'application/octet-stream';
    let originalName = fileKey;
    if (metaHeader) {
      try {
        const meta = JSON.parse(typeof metaHeader === 'string' ? metaHeader : String(metaHeader));
        mime = meta.Mime || mime;
        originalName = meta.FileName || originalName;
      } catch { /* ignore */ }
    }

    const isImage = resourceType === 'image' || mime.startsWith('image/');
    const dir = isImage ? IMAGES_DIR : FILES_DIR;

    // 确定文件名
    let finalName: string;
    if (fileName) {
      finalName = fileName;
    } else {
      finalName = originalName === 'image' ? fileKey : originalName;
      // 添加扩展名
      const ext = mime.startsWith('image/')
        ? mime.split('/')[1]
        : (resourceType === 'image' ? 'png' : mime.split('/')[1]);
      if (ext && !finalName.includes('.')) {
        finalName += `.${ext}`;
      }
    }

    // 去重：同名文件加序号
    const extname = path.extname(finalName);
    let baseName = finalName.substring(0, finalName.length - extname.length);
    let targetPath = path.join(dir, finalName);
    let i = 1;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(dir, `${baseName}-${i}${extname}`);
      i++;
    }

    // 写入文件
    const writeFile = (response as any).writeFile;
    if (typeof writeFile === 'function') {
      await writeFile(targetPath);
    } else {
      // fallback: response 可能是 ArrayBuffer 或 Buffer
      const data = (response as any).data;
      if (data) {
        fs.writeFileSync(targetPath, Buffer.from(data));
      }
    }

    // 返回相对于 agent_home 的路径
    const agentHome = path.resolve(process.env.HOME || '', 'workspace/sage/agent_home');
    return path.relative(agentHome, targetPath);
  }

  /** 将飞书富文本 post 转换为 markdown */
  private async convertPostToMarkdown(
    messageId: string,
    postContent: any,
  ): Promise<{ text: string; attachments?: MessageAttachment[] }> {
    const attachments: MessageAttachment[] = [];
    const lines: string[] = [];

    // post 格式: { title?, content: [[element, ...], ...] } 或 { zh_cn: { title, content } }
    let title = postContent.title;
    let content = postContent.content;
    if (!content && postContent.zh_cn) {
      title = postContent.zh_cn.title;
      content = postContent.zh_cn.content;
    }

    if (title) {
      lines.push(`**${title}**\n`);
    }

    if (!Array.isArray(content)) return { text: lines.join('') || '（富文本消息）', attachments };

    for (const paragraph of content) {
      if (!Array.isArray(paragraph)) continue;
      let line = '';
      for (const elem of paragraph) {
        switch (elem.tag) {
          case 'text': {
            let text = elem.text || '';
            if (elem.style) {
              if (elem.style.includes('bold')) text = `**${text}**`;
              if (elem.style.includes('italic')) text = `*${text}*`;
              if (elem.style.includes('underline')) text = `<u>${text}</u>`;
              if (elem.style.includes('lineThrough')) text = `~~${text}~~`;
            }
            line += text;
            break;
          }
          case 'a':
            line += `[${elem.text || elem.href}](${elem.href})`;
            break;
          case 'at':
            line += `@${elem.user_name || elem.user_id || 'user'}`;
            break;
          case 'img': {
            const imageKey = elem.image_key || elem.file_key;
            if (!imageKey) {
              line += `[图片]`;
              break;
            }

            try {
              const localPath = await this.downloadMessageResource(messageId, imageKey, undefined, 'image');
              line += `![user_uploaded_image](${localPath})`;
              attachments.push({ type: 'image', path: localPath });
            } catch (error) {
              this.logger.warn(`富文本图片下载失败: message=${messageId}, image=${imageKey}`, error);
              line += `[图片: 下载失败]`;
            }
            break;
          }
          case 'code_block':
            line += `\n\`\`\`${elem.language || ''}\n${elem.text || ''}\n\`\`\`\n`;
            break;
          case 'hr':
            line += '\n---\n';
            break;
          case 'emotion':
            line += `[${elem.emoji_type || '表情'}]`;
            break;
          default:
            if (elem.text) line += elem.text;
            break;
        }
      }
      lines.push(line);
    }

    return {
      text: lines.join('\n') || '（富文本消息）',
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  }

  // ─── 卡片构建与发送（Phase 2）───

  /** 发送初始卡片回复，返回 {messageId, threadId} */
  async replyCard(parentMessageId: string, cardJson: string): Promise<{ messageId: string; threadId?: string }> {
    const response = await this.client.im.v1.message.reply({
      path: { message_id: parentMessageId },
      data: {
        content: cardJson,
        msg_type: 'interactive',
        reply_in_thread: true,
      },
    });

    const replyData = response?.data as any;
    const messageId = replyData?.message_id || '';
    const threadId = replyData?.thread_id;

    if (threadId) {
      this.messageThreadMap.set(parentMessageId, threadId);
      this.logger.info(`记录 thread 映射: ${parentMessageId} -> ${threadId}`);
    }

    return { messageId, threadId };
  }

  /** PATCH 更新卡片内容 */
  async patchCard(messageId: string, cardJson: string): Promise<boolean> {
    if (this.failedPatchMessages.has(messageId)) return false;

    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson },
      });
      return true;
    } catch (err: any) {
      // 400 错误标记为失败，不再重试
      const status = err?.status || err?.response?.status || err?.code;
      if (status === 400) {
        this.failedPatchMessages.add(messageId);
        this.logger.warn(`卡片 PATCH 失败 (400), messageId: ${messageId}`);
        return false;
      }
      throw err;
    }
  }

  /** 发送纯文本回复（卡片更新失败时的兜底） */
  async replyText(messageId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          reply_in_thread: true,
        },
      });
    } catch (err) {
      this.logger.warn('发送兜底文本失败:', err);
    }
  }

  /** 构建流式卡片（含中间步骤的 collapsible_panel + 流式文字） */
  buildStreamingCard(events: AgentEvent[], streaming: boolean, resultText?: string): string {
    return renderStreamingCard(events, streaming, resultText);
  }

  /** 构建错误卡片 */
  buildErrorCard(errorText: string): string {
    return renderErrorCard(errorText);
  }

  // ─── Phase 3: 上传图片/文件 ───

  /** 上传本地图片到飞书，返回 image_key */
  async uploadImage(localPath: string): Promise<string> {
    const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(AGENT_HOME_DIR, localPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`图片文件不存在: ${absPath}`);
    }

    const file = fs.readFileSync(absPath);
    this.logger.debug(`上传图片: name=${path.basename(absPath)}, bytes=${file.length}`);

    const res = await (this.client.im as any).v1.image.create({
      data: { image_type: 'message', image: file },
    });

    const imageKey = res?.image_key || res?.data?.image_key;
    if (!imageKey) {
      throw new Error('上传图片失败，无 image_key');
    }

    this.logger.info(`图片上传成功: name=${path.basename(absPath)}, imageKey=${imageKey}`);
    return imageKey;
  }

  /** 上传本地文件到飞书，返回 file_key */
  async uploadFile(localPath: string): Promise<string> {
    const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(AGENT_HOME_DIR, localPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`文件不存在: ${absPath}`);
    }

    const file = fs.createReadStream(absPath);
    const fileName = path.basename(absPath);
    const ext = path.extname(absPath).slice(1).toLowerCase();
    const fileTypeMap: Record<string, string> = {
      opus: 'opus', mp4: 'mp4', pdf: 'pdf',
      doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls',
      ppt: 'ppt', pptx: 'ppt',
    };
    const fileType = fileTypeMap[ext] ?? 'stream';

    this.logger.debug(`上传文件: name=${fileName}, type=${fileType}`);

    const res = await (this.client.im as any).v1.file.create({
      data: { file_type: fileType, file_name: fileName, file },
    });

    const fileKey = res?.file_key || res?.data?.file_key;
    if (!fileKey) {
      throw new Error('上传文件失败，无 file_key');
    }

    this.logger.info(`文件上传成功: name=${fileName}, fileKey=${fileKey}`);
    return fileKey;
  }

  /** 在 thread 中回复文件消息 */
  async sendFileReply(messageId: string, fileKey: string): Promise<void> {
    await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
        reply_in_thread: true,
      },
    });
  }

  /** 处理最终回复中的本地图片：上传替换为 image_key */
  async processImagesInMarkdown(text: string): Promise<string> {
    const processSegment = async (segment: string): Promise<string> => {
      let result = '';
      let lastIndex = 0;
      const matches = [...segment.matchAll(MARKDOWN_IMAGE_REGEX)];

      for (const match of matches) {
        const [full, alt, src] = match;
        const index = match.index ?? 0;
        result += segment.slice(lastIndex, index);
        lastIndex = index + full.length;

        if (isRemoteImageSource(src)) {
          result += full;
          continue;
        }

        try {
          const imageKey = await this.uploadImage(src);
          result += `![${alt || 'image'}](${imageKey})`;
        } catch (err) {
          this.logger.warn(`处理图片失败，降级为链接: src=${sanitizeLogValue(src, 160)}`, err);
          result += `[${alt || '图片'}](${src})`;
        }
      }

      result += segment.slice(lastIndex);
      return result;
    };

    let result = '';
    let lastIndex = 0;
    const codeBlocks = [...text.matchAll(FENCED_CODE_BLOCK_REGEX)];

    for (const block of codeBlocks) {
      const index = block.index ?? 0;
      result += await processSegment(text.slice(lastIndex, index));
      result += block[0];
      lastIndex = index + block[0].length;
    }

    result += await processSegment(text.slice(lastIndex));
    return result;
  }

  /** 提取并发送本地文件附件 */
  async sendLocalFileAttachments(messageId: string, text: string): Promise<void> {
    // 匹配 [text](path) 但排除 ![image](path)
    const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
    const seen = new Set<string>();

    for (const match of text.matchAll(linkRegex)) {
      let [, , filePath] = match;
      if (!filePath || seen.has(filePath)) continue;

      // 兼容 file:// 前缀（Unix 绝对路径如 file:///path/to/file → /path/to/file）
      if (filePath.startsWith('file://')) {
        filePath = filePath.slice('file://'.length);
      }
      if (!filePath) continue;

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(AGENT_HOME_DIR, filePath);
      if (!fs.existsSync(absPath)) continue;

      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this.sendFileReply(messageId, fileKey);
        this.logger.info(`文件附件已发送: name=${path.basename(absPath)}`);
      } catch (err) {
        this.logger.warn(`发送文件附件失败: name=${path.basename(absPath)}`, err);
      }
    }
  }

  // ─── 基础方法 ───

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

  async sendTextMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
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

  /** 通过 open_id 向用户主动发消息，返回 message_id */
  async sendTextToUser(openId: string, text: string): Promise<string> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      const messageId = (resp as any)?.data?.message_id || '';
      this.logger.info(`主动消息发送成功: open=${openId}, msg=${messageId}`);
      return messageId;
    } catch (error) {
      throw new AppError('发送主动消息失败', 'SEND_PROACTIVE_MESSAGE_FAILED');
    }
  }

  async sendProactiveText(openId: string, text: string): Promise<string> {
    return this.sendTextToUser(openId, text);
  }

  /** 通过 open_id 向用户主动发送交互卡片，返回 message_id */
  async sendCardToUser(openId: string, cardJson: string): Promise<string> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          content: cardJson,
          msg_type: 'interactive',
        },
      });
      const messageId = (resp as any)?.data?.message_id || '';
      this.logger.info(`主动卡片发送成功: open=${openId}, msg=${messageId}`);
      return messageId;
    } catch (error) {
      throw new AppError('发送主动卡片失败', 'SEND_PROACTIVE_CARD_FAILED');
    }
  }

  getThreadIdByMessageId(messageId: string): string | undefined {
    return this.messageThreadMap.get(messageId);
  }

  async start(): Promise<void> {
    try {
      this.logger.info('正在启动飞书服务...');
      await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      this.logger.info('飞书服务启动成功');
    } catch (error) {
      throw new AppError('启动飞书服务失败', 'START_SERVICE_FAILED');
    }
  }

  async stop(): Promise<void> {
    try {
      this.logger.info('正在停止飞书服务...');
      (this.wsClient as any).stop?.();
      this.logger.info('飞书服务已停止');
    } catch (error) {
      this.logger.error('停止飞书服务失败:', error);
    }
  }

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

  private isDuplicateMessage(eventId: string): boolean {
    // L1: 内存缓存
    if (this.processedMessages.has(eventId)) return true;
    // L2: DB 兜底（重启后内存为空，靠 DB 防重复）
    if (this.dbDedupFn) {
      if (this.dbDedupFn(eventId)) return true;
    }
    this.processedMessages.add(eventId);
    if (this.processedMessages.size > 1000) this.cleanupProcessedMessages();
    return false;
  }

  private cleanupProcessedMessages(): void {
    const entries = Array.from(this.processedMessages.entries());
    const toKeep = entries.slice(-500);
    this.processedMessages.clear();
    toKeep.forEach(([eventId]) => this.processedMessages.add(eventId));
    this.logger.info(`清理已处理消息，保留最近 ${toKeep.length} 个`);

    if (this.messageThreadMap.size > 1000) {
      const threadEntries = Array.from(this.messageThreadMap.entries());
      const threadToKeep = threadEntries.slice(-500);
      this.messageThreadMap.clear();
      threadToKeep.forEach(([k, v]) => this.messageThreadMap.set(k, v));
      this.logger.info(`清理 thread 映射，保留最近 ${threadToKeep.length} 个`);
    }
  }
}

class FeishuAssistantResponder implements AssistantResponder {
  private readonly logger = new Logger('FeishuResponder');
  private rootMessageId?: string;
  private currentMessageId = '';
  private threadId?: string;
  private eventBaseIndex = 0;
  private readonly messageIds = new Set<string>();

  constructor(
    private readonly service: FeishuService,
    private readonly anchor: ResponseAnchor,
  ) {}

  async start(): Promise<ResponseBinding> {
    if (this.currentMessageId) return this.binding();

    const initialCard = this.service.buildStreamingCard([], true);
    if (this.anchor.kind === 'reply') {
      const response = await this.service.replyCard(this.anchor.parentMessageId, initialCard);
      this.rememberReply(response);
      return this.binding();
    }

    if (!this.rootMessageId) {
      this.rootMessageId = await this.service.sendTextToUser(this.anchor.openId, this.anchor.topic);
    }
    if (!this.rootMessageId) return this.binding();

    try {
      const response = await this.service.replyCard(this.rootMessageId, initialCard);
      this.rememberReply(response);
    } catch (err) {
      this.logger.warn(`主动任务根消息已发送但初始回复失败: root=${this.rootMessageId}`, err);
    }
    return this.binding();
  }

  async update(snapshot: AssistantResponseSnapshot): Promise<ResponseBinding | void> {
    if (!this.currentMessageId) {
      const binding = await this.start();
      if (!binding.messageId) return binding;
    }

    const currentEvents = snapshot.events.slice(this.eventBaseIndex);
    if (currentEvents.length === 0) return this.binding();

    const stepsOnlyEvents = currentEvents.filter(event => event.type !== 'text');
    const stepsCard = this.service.buildStreamingCard(stepsOnlyEvents, true);
    const stepsSize = Buffer.byteLength(stepsCard, 'utf-8');

    if (stepsSize > CARD_SIZE_LIMIT) {
      const previousEvents = currentEvents.slice(0, -1);
      const closingCard = this.service.buildStreamingCard(
        previousEvents,
        false,
        '↓ 内容较长，后续内容见下方卡片',
      );
      await this.service.patchCard(this.currentMessageId, closingCard).catch(() => {});

      const nextEvents = currentEvents.slice(-1);
      const newCard = this.service.buildStreamingCard(nextEvents, true);
      const response = await this.service.replyCard(this.currentMessageId, newCard);
      this.rememberReply(response);
      this.eventBaseIndex = Math.max(0, snapshot.events.length - nextEvents.length);
      this.logger.info(`steps 超限 (${stepsSize}B)，已开新卡: ${this.currentMessageId}`);
      return this.binding();
    }

    const card = this.buildStreamingUpdateCard(currentEvents);
    const patchOk = await this.service.patchCard(this.currentMessageId, card);
    if (!patchOk) {
      const nextEvents = currentEvents.slice(-1);
      const newCard = this.buildStreamingUpdateCard(nextEvents);
      const response = await this.service.replyCard(this.currentMessageId, newCard);
      this.rememberReply(response);
      this.eventBaseIndex = Math.max(0, snapshot.events.length - nextEvents.length);
      this.logger.warn(`流式 PATCH 失败，已开新卡: ${this.currentMessageId}`);
    }

    return this.binding();
  }

  async complete(result: AssistantResponseResult): Promise<ResponseBinding> {
    if (!this.currentMessageId) {
      return this.replyFinal(result);
    }

    await this.patchFinal(result);
    return this.binding();
  }

  async fail(message: string): Promise<ResponseBinding | void> {
    const card = this.service.buildErrorCard(message);
    if (this.currentMessageId) {
      await this.service.patchCard(this.currentMessageId, card).catch(() => {});
      return this.binding();
    }

    if (this.anchor.kind === 'reply') {
      const response = await this.service.replyCard(this.anchor.parentMessageId, card);
      this.rememberReply(response);
      return this.binding();
    }

    await this.start();
    if (this.currentMessageId) {
      await this.service.patchCard(this.currentMessageId, card).catch(() => {});
    }
    return this.binding();
  }

  async close(reason: string): Promise<void> {
    if (!this.currentMessageId) return;
    const shutdownCard = this.service.buildStreamingCard([], false, reason);
    await this.service.patchCard(this.currentMessageId, shutdownCard).catch(() => {});
  }

  private buildStreamingUpdateCard(events: AgentEvent[]): string {
    const card = this.service.buildStreamingCard(events, true);
    const latestText = this.latestTextEvent(events)?.content || '';

    if (
      !latestText ||
      (!hasTooManyMarkdownTables(latestText) && Buffer.byteLength(card, 'utf-8') <= CARD_SIZE_LIMIT)
    ) {
      return card;
    }

    const safeEvents = this.replaceLatestTextEvent(
      events,
      '内容较长或表格较多，最终回复会拆分展示。',
    );
    return this.service.buildStreamingCard(safeEvents, true);
  }

  private latestTextEvent(events: AgentEvent[]): AgentEvent | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === 'text' && event.content) return event;
    }
    return undefined;
  }

  private replaceLatestTextEvent(events: AgentEvent[], content: string): AgentEvent[] {
    const nextEvents = events.slice();
    for (let i = nextEvents.length - 1; i >= 0; i--) {
      const event = nextEvents[i];
      if (event?.type === 'text') {
        nextEvents[i] = { ...event, content };
        break;
      }
    }
    return nextEvents;
  }

  private async replyFinal(result: AssistantResponseResult): Promise<ResponseBinding> {
    if (this.anchor.kind === 'proactive') {
      await this.start();
      if (this.currentMessageId) {
        await this.patchFinal(result);
      }
      return this.binding();
    }

    const finalText = await this.prepareFinalText(result.text);
    const chunks = splitMarkdownByTables(finalText);
    const firstChunkText = chunks[0] || finalText;
    const card = this.service.buildStreamingCard(result.events, false, firstChunkText);

    if (Buffer.byteLength(card, 'utf-8') > CARD_SIZE_LIMIT) {
      const response = await this.service.replyCard(
        this.anchor.parentMessageId,
        this.service.buildStreamingCard(result.events, false, '↓ 回复内容见下方卡片'),
      );
      this.rememberReply(response);
      await this.replyTextChunks(chunks, finalText);
      return this.binding();
    }

    const response = await this.service.replyCard(this.anchor.parentMessageId, card);
    this.rememberReply(response);
    await this.replyRemainingChunks(chunks);
    await this.service.sendLocalFileAttachments(this.currentMessageId, finalText);
    return this.binding();
  }

  private async patchFinal(result: AssistantResponseResult): Promise<void> {
    const finalText = await this.prepareFinalText(result.text);
    const chunks = splitMarkdownByTables(finalText);
    const firstChunkText = chunks[0] || finalText;
    const currentEvents = result.events.slice(this.eventBaseIndex);
    const finalCard = this.service.buildStreamingCard(currentEvents, false, firstChunkText);
    const finalCardSize = Buffer.byteLength(finalCard, 'utf-8');

    if (finalCardSize > CARD_SIZE_LIMIT) {
      this.logger.info(`最终卡片超限 (${finalCardSize}B)，steps 留当前卡，文本开新卡 (${chunks.length} 块)`);
      const stepsCard = this.service.buildStreamingCard(currentEvents, false, '↓ 回复内容见下方卡片');
      await this.service.patchCard(this.currentMessageId, stepsCard).catch(() => {});
      await this.replyTextChunks(chunks, finalText);
    } else {
      const patchOk = await this.service.patchCard(this.currentMessageId, finalCard);
      if (!patchOk) {
        await this.service.replyText(this.currentMessageId, finalText);
        await this.service.sendLocalFileAttachments(this.currentMessageId, finalText);
        return;
      }
      await this.replyRemainingChunks(chunks);
      await this.service.sendLocalFileAttachments(this.currentMessageId, finalText);
    }
  }

  private async prepareFinalText(text: string): Promise<string> {
    try {
      return await this.service.processImagesInMarkdown(text);
    } catch (err) {
      this.logger.warn('处理回复中的图片失败:', err);
      return text;
    }
  }

  private async replyTextChunks(chunks: string[], finalText: string): Promise<void> {
    const anchorMessageId = this.currentMessageId;
    for (const chunk of chunks) {
      const chunkCard = this.service.buildStreamingCard([], false, chunk);
      if (Buffer.byteLength(chunkCard, 'utf-8') > CARD_SIZE_LIMIT) {
        this.logger.warn('文本 chunk 仍超限，降级为纯文本');
        await this.service.replyText(anchorMessageId, chunk);
      } else {
        try {
          const response = await this.service.replyCard(anchorMessageId, chunkCard);
          this.rememberReply(response, false);
        } catch (err) {
          this.logger.warn('文本 chunk 卡片发送失败，降级为纯文本', err);
          await this.service.replyText(anchorMessageId, chunk);
        }
      }
    }
    await this.service.sendLocalFileAttachments(anchorMessageId, finalText);
  }

  private async replyRemainingChunks(chunks: string[]): Promise<void> {
    const anchorMessageId = this.currentMessageId;
    for (let i = 1; i < chunks.length; i++) {
      const chunkCard = this.service.buildStreamingCard([], false, chunks[i]!);
      if (Buffer.byteLength(chunkCard, 'utf-8') > CARD_SIZE_LIMIT) {
        this.logger.warn('文本 chunk 仍超限，降级为纯文本');
        await this.service.replyText(anchorMessageId, chunks[i]!);
        continue;
      }

      try {
        const response = await this.service.replyCard(anchorMessageId, chunkCard);
        this.rememberReply(response, false);
      } catch (err) {
        this.logger.warn('文本 chunk 卡片发送失败，降级为纯文本', err);
        await this.service.replyText(anchorMessageId, chunks[i]!);
      }
    }
  }

  private rememberReply(response: { messageId: string; threadId?: string }, setCurrent = true): void {
    if (response.messageId) {
      if (setCurrent) {
        this.currentMessageId = response.messageId;
      }
      this.messageIds.add(response.messageId);
    }
    if (response.threadId) {
      this.threadId = response.threadId;
    }
  }

  private binding(): ResponseBinding {
    return {
      rootMessageId: this.rootMessageId,
      messageId: this.currentMessageId || undefined,
      messageIds: Array.from(this.messageIds),
      threadId: this.threadId,
    };
  }
}
