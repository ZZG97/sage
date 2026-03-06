import * as Lark from '@larksuiteoapi/node-sdk';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

/**
 * 配置应用基础信息和请求域名。
 * App base information and request domain name.
 */
const baseConfig = {
  // 应用的 AppID, 你可以在开发者后台获取。 AppID of the application, you can get it in the developer console.
  appId: process.env.APP_ID || '',
  // 应用的 AppSecret，你可以在开发者后台获取。 AppSecret of the application, you can get it in the developer console.
  appSecret: process.env.APP_SECRET || '',
  // 请求域名，如： `https://open.feishu.cn。`  Request domain name, such as `https://open.feishu.cn.` 
  domain: process.env.BASE_DOMAIN || 'https://open.feishu.cn',
};

/**
 * 创建 LarkClient 对象，用于请求OpenAPI, 并创建 LarkWSClient 对象，用于使用长连接接收事件。
 * Create LarkClient object for requesting OpenAPI, and create LarkWSClient object for receiving events using long connection.
 */
const client = new Lark.Client(baseConfig);
const wsClient = new Lark.WSClient(baseConfig);

/**
 * 注册事件处理器。
 * Register event handler.
 */
const eventDispatcher = new Lark.EventDispatcher({})
  .register({
    /**
     * 注册接收消息事件，处理接收到的消息。
     * Register event handler to handle received messages.
     * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive 
     */
    'im.message.receive_v1': async (data) => {
      console.log('收到消息事件:', JSON.stringify(data, null, 2));
      
      const {
        message: { chat_id, content, message_type, chat_type, message_id },
      } = data;

      /**
       * 解析用户发送的消息。
       * Parse the message sent by the user.
       */
      let responseText = '';

      try {
        if (message_type === 'text') {
          responseText = JSON.parse(content).text;
          console.log(`用户消息内容: ${responseText}`);
        } else {
          responseText = '解析消息失败，请发送文本消息 \nparse message failed, please send text message';
          console.log('非文本消息，使用默认回复');
        }
      } catch (error) {
        // 解析消息失败，返回错误信息。 Parse message failed, return error message.
        console.error('解析消息失败:', error);
        responseText = '解析消息失败，请发送文本消息 \nparse message failed, please send text message';
      }

      try {
        if (chat_type === 'p2p') {
          /**
           * 单聊：使用SDK调用发送消息接口。 Use SDK to call send message interface.
           * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create 
           */
          console.log('处理单聊消息');
          await client.im.v1.message.create({
            params: {
              receive_id_type: 'chat_id', // 消息接收者的 ID 类型，设置为会话ID。 ID type of the message receiver, set to chat ID.
            },
            data: {
              receive_id: chat_id, // 消息接收者的 ID 为消息发送的会话ID。 ID of the message receiver is the chat ID of the message sending.
              content: JSON.stringify({ 
                text: `收到你发送的消息: ${responseText}\nReceived message: ${responseText}` 
              }),
              msg_type: 'text', // 设置消息类型为文本消息。 Set message type to text message.
            },
          });
          console.log('单聊回复发送成功');
        } else {
          /**
           * 群聊：使用SDK调用回复消息接口。 Use SDK to call reply message interface.
           * https://open.feishu.cn/document/server-docs/im-v1/message/reply 
           */
          console.log('处理群聊消息');
          await client.im.v1.message.reply({
            path: {
              message_id: message_id, // 要回复的消息 ID。 Message ID to reply.
            },
            data: {
              content: JSON.stringify({ 
                text: `收到你发送的消息: ${responseText}\nReceived message: ${responseText}` 
              }),
              msg_type: 'text', // 设置消息类型为文本消息。 Set message type to text message.
            },
          });
          console.log('群聊回复发送成功');
        }
      } catch (error) {
        console.error('发送回复消息失败:', error);
      }
    },
  })
  .register({
    /**
     * 注册连接事件，监听长连接状态。
     * Register connection event to monitor long connection status.
     */
    'connection': async (data) => {
      console.log('长连接状态变更:', data);
    },
  });

/**
 * 启动长连接，并注册事件处理器。
 * Start long connection and register event handler.
 */
console.log('正在启动飞书Echo Bot长连接...');
console.log('应用配置:');
console.log('- AppID:', baseConfig.appId);
console.log('- Domain:', baseConfig.domain);
console.log('');
console.log('长连接优势：');
console.log('- 实时接收事件，无需配置Webhook');
console.log('- 自动重连机制');
console.log('- 更低的延迟');
console.log('');

wsClient.start({ eventDispatcher });

console.log('飞书Echo Bot长连接已启动！');
console.log('机器人现在可以接收和回复消息了。');
console.log('');
console.log('使用说明：');
console.log('1. 在飞书中与机器人对话，机器人会自动回复');
console.log('2. 在群聊中@机器人，机器人会回复被@的消息');
console.log('3. 支持文本消息处理');
console.log('');
console.log('按 Ctrl+C 停止服务');

// 处理进程退出
process.on('SIGINT', async () => {
  console.log('\n正在关闭长连接...');
  try {
    wsClient.stop();
    console.log('长连接已关闭');
  } catch (error) {
    console.error('关闭长连接失败:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', promise, '原因:', reason);
});