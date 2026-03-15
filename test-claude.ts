// 快速测试 ClaudeCodeProvider — 直接调 SDK 验证小克身份
import { ClaudeCodeProvider } from './src/agent/claude-code-provider';

const provider = new ClaudeCodeProvider({
  type: 'claude-code',
  workDir: `${process.env.HOME}/workspace/agent_home`,
  maxTurns: 5,
  model: 'claude-sonnet-4-6',
});

async function test() {
  console.log('=== 初始化 ===');
  await provider.initialize();

  console.log('\n=== 健康检查 ===');
  const healthy = await provider.healthCheck();
  console.log('健康:', healthy);
  if (!healthy) {
    console.error('健康检查失败，退出');
    process.exit(1);
  }

  console.log('\n=== 创建会话 ===');
  const session = await provider.createSession();
  console.log('会话 ID:', session.id);

  console.log('\n=== 发送消息: "你是谁？" ===');
  const start = Date.now();
  const response = await provider.sendMessage(session.id, '你是谁？简单介绍一下自己。');
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n回复 (${elapsed}s):\n${response.text}`);

  // 清理
  await provider.deleteSession(session.id);
  await provider.destroy();
}

test().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
