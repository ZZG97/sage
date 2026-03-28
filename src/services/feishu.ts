import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { BaseConfig, FeishuMessage, FeishuTextContent, MessageContext, MessageAttachment } from '../types';
import { AgentEvent } from '../agent/types';
import { Logger, AppError } from '../utils';

// 上传目录（相对于 agent_home）
const UPLOADS_DIR = path.resolve(process.env.HOME || '', 'workspace/sage/agent_home/workspace/uploads');
const IMAGES_DIR = path.join(UPLOADS_DIR, 'images');
const FILES_DIR = path.join(UPLOADS_DIR, 'files');

// 工具图标映射
const TOOL_ICONS: Record<string, string> = {
  Read: 'file-link-bitable_outlined',
  Write: 'edit_outlined',
  Edit: 'edit_outlined',
  Bash: 'computer_outlined',
  Glob: 'card-search_outlined',
  Grep: 'doc-search_outlined',
  WebSearch: 'search_outlined',
  WebFetch: 'language_outlined',
  Agent: 'robot_outlined',
  Skill: 'file-link-mindnote_outlined',
  // codex
  command: 'computer_outlined',
  file_change: 'edit_outlined',
  web_search: 'search_outlined',
};

export class FeishuService {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private eventDispatcher: Lark.EventDispatcher;
  private logger: Logger;
  private messageHandler?: (ctx: MessageContext) => Promise<void>;
  private threadCreatedHandler?: (messageId: string, threadId: string) => void;
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

  setThreadCreatedHandler(handler: (messageId: string, threadId: string) => void) {
    this.threadCreatedHandler = handler;
  }

  /** 注入 DB 去重函数（HistoryStore.isDuplicateEvent），重启后兜底 */
  setDedupFn(fn: (eventId: string) => boolean) {
    this.dbDedupFn = fn;
  }

  // ─── 事件处理 ───

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

  private async handleMessage(data: FeishuMessage): Promise<void> {
    const { message, sender, event_id } = data as any;
    this.logger.info('收到消息事件:', JSON.stringify(data, null, 2));

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

      this.logger.info(`用户消息: type=${message.message_type}, text="${parsed.text.slice(0, 100)}", openId=${openId}, threadId=${threadId || '无'}, messageId=${message.message_id}`);

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
          const localPath = await this.downloadMessageResource(message.message_id, fileKey);
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
          const result = this.convertPostToMarkdown(content);
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
  async downloadMessageResource(messageId: string, fileKey: string, fileName?: string): Promise<string> {
    const response = await this.client.im.v1.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: 'file',
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

    const isImage = mime.startsWith('image/');
    const dir = isImage ? IMAGES_DIR : FILES_DIR;

    // 确定文件名
    let finalName: string;
    if (fileName) {
      finalName = fileName;
    } else {
      finalName = originalName === 'image' ? fileKey : originalName;
      // 添加扩展名
      const ext = mime.split('/')[1];
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
  private convertPostToMarkdown(postContent: any): { text: string; attachments?: MessageAttachment[] } {
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
          case 'img':
            // post 中的图片，暂不下载（需要额外 API），标注为图片标记
            line += `[图片]`;
            break;
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
      this.threadCreatedHandler?.(parentMessageId, threadId);
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

  /** 构建流式卡片（含中间步骤的 collapsible_panel + 流式文字） */
  buildStreamingCard(events: AgentEvent[], streaming: boolean, resultText?: string): string {
    const steps: any[] = [];
    let thinkingCount = 0;
    const textParts: string[] = [];
    const notices: string[] = [];

    for (const event of events) {
      if (event.type === 'thinking') {
        thinkingCount++;
      } else if (event.type === 'tool_call') {
        const icon = TOOL_ICONS[event.toolName || ''] || 'setting-inter_outlined';
        steps.push({
          tag: 'div',
          icon: { tag: 'standard_icon', token: icon, color: 'grey' },
          text: {
            tag: 'plain_text',
            text_color: 'grey',
            text_size: 'notation',
            content: event.content || event.toolName || 'tool',
          },
        });
      } else if (event.type === 'notice' && event.content) {
        notices.push(event.content);
      } else if (event.type === 'text' && event.content) {
        textParts.push(event.content);
      }
    }

    // 如果有 thinking 事件，加一个汇总步骤
    if (thinkingCount > 0) {
      steps.unshift({
        tag: 'div',
        icon: { tag: 'standard_icon', token: 'robot_outlined', color: 'grey' },
        text: {
          tag: 'plain_text',
          text_color: 'grey',
          text_size: 'notation',
          content: 'Thinking...',
        },
      });
    }

    const elements: any[] = [];

    // notice banner（fallback 等系统提示，始终显示在顶部，不被 resultText 覆盖）
    if (notices.length > 0) {
      elements.push({
        tag: 'markdown',
        text_size: 'notation',
        text_align: 'left',
        content: notices.join(' | '),
      });
    }

    // collapsible_panel（有步骤时才显示）
    if (steps.length > 0) {
      const stepCount = steps.length;
      const stepCountText = `${stepCount} step${stepCount === 1 ? '' : 's'}`;

      elements.push({
        tag: 'collapsible_panel',
        expanded: streaming,
        border: { color: 'grey-300', corner_radius: '6px' },
        vertical_spacing: '2px',
        header: {
          title: {
            tag: 'plain_text',
            text_color: 'grey',
            text_size: 'notation',
            content: streaming ? `Working on it (${stepCountText})` : `Show ${stepCountText}`,
          },
          icon: { tag: 'standard_icon', token: 'right_outlined', color: 'grey' },
          icon_position: 'right',
          icon_expanded_angle: 90,
        },
        elements: steps,
      });
    }

    // 文字内容：streaming 时显示中间 text，完成时显示 resultText
    const displayText = streaming ? textParts.join('\n\n') : resultText;
    if (displayText) {
      elements.push({
        tag: 'markdown',
        content: displayText,
      });
    }

    // streaming 指示器
    if (streaming) {
      elements.push({
        tag: 'div',
        icon: { tag: 'standard_icon', token: 'more_outlined', color: 'grey' },
      });
    }

    // 确保 elements 不为空
    if (elements.length === 0) {
      elements.push({
        tag: 'div',
        text: { tag: 'plain_text', content: '' },
      });
    }

    const summary = streaming
      ? (textParts.length > 0 ? textParts[textParts.length - 1].slice(0, 100) : (steps.length > 0 ? `Working on it (${steps.length} steps)` : 'Thinking...'))
      : (resultText?.slice(0, 100) || '');

    const card = {
      schema: '2.0',
      config: {
        streaming_mode: true,
        update_multi: true,
        enable_forward: true,
        width_mode: 'fill',
        summary: { content: summary },
      },
      body: { elements },
    };

    return JSON.stringify(card);
  }

  /** 构建错误卡片 */
  buildErrorCard(errorText: string): string {
    return JSON.stringify({
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        elements: [{ tag: 'markdown', content: errorText }],
      },
    });
  }

  // ─── Phase 3: 上传图片/文件 ───

  /** 上传本地图片到飞书，返回 image_key */
  async uploadImage(localPath: string): Promise<string> {
    const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(UPLOADS_DIR, '..', localPath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`图片文件不存在: ${absPath}`);
    }

    const file = fs.readFileSync(absPath);
    this.logger.info(`上传图片: ${absPath}`);

    const res = await (this.client.im as any).v1.image.create({
      data: { image_type: 'message', image: file },
    });

    const imageKey = res?.image_key || res?.data?.image_key;
    if (!imageKey) {
      throw new Error('上传图片失败，无 image_key');
    }

    this.logger.info(`图片上传成功: ${absPath} -> ${imageKey}`);
    return imageKey;
  }

  /** 上传本地文件到飞书，返回 file_key */
  async uploadFile(localPath: string): Promise<string> {
    const absPath = path.isAbsolute(localPath) ? localPath : path.resolve(UPLOADS_DIR, '..', localPath);
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

    this.logger.info(`上传文件: ${absPath} (type: ${fileType})`);

    const res = await (this.client.im as any).v1.file.create({
      data: { file_type: fileType, file_name: fileName, file },
    });

    const fileKey = res?.file_key || res?.data?.file_key;
    if (!fileKey) {
      throw new Error('上传文件失败，无 file_key');
    }

    this.logger.info(`文件上传成功: ${absPath} -> ${fileKey}`);
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
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let result = text;
    const matches = [...text.matchAll(imageRegex)];

    for (const match of matches) {
      const [full, alt, src] = match;
      // 跳过已经是 image_key 或 URL 的
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('img_')) continue;

      try {
        const imageKey = await this.uploadImage(src);
        result = result.replace(full, `![${alt || 'image'}](${imageKey})`);
      } catch (err) {
        this.logger.warn(`处理图片失败，降级为链接: ${src}`, err);
        result = result.replace(full, `[${alt || '图片'}](${src})`);
      }
    }
    return result;
  }

  /** 提取并发送本地文件附件 */
  async sendLocalFileAttachments(messageId: string, text: string): Promise<void> {
    // 匹配 [text](path) 但排除 ![image](path)
    const linkRegex = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;
    const seen = new Set<string>();

    for (const match of text.matchAll(linkRegex)) {
      const [, , filePath] = match;
      if (!filePath || filePath.includes('://') || seen.has(filePath)) continue;

      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(UPLOADS_DIR, '..', filePath);
      if (!fs.existsSync(absPath)) continue;

      seen.add(filePath);
      try {
        const fileKey = await this.uploadFile(filePath);
        await this.sendFileReply(messageId, fileKey);
        this.logger.info(`文件附件已发送: ${filePath}`);
      } catch (err) {
        this.logger.warn(`发送文件附件失败: ${filePath}`, err);
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
