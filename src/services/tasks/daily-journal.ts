// 定时任务：每日日记生成（触发器，逻辑由 memory skill 执行）
// 走 runAgentTask → SageCore.runAgentForOwner → 流式卡片，与用户对话体验一致。
// 退化路径：没有 owner 时回退到旧的裸 agent.sendMessage。
import type { TaskContext } from '../task-scheduler';

export async function dailyJournal(ctx: TaskContext): Promise<void> {
  const prompt = '请总结今天的对话记录，生成日记';
  if (ctx.runAgentTask) {
    await ctx.runAgentTask(prompt);
    return;
  }
  const session = await ctx.agent.createSession();
  try {
    await ctx.agent.sendMessage(session.id, prompt);
  } finally {
    await ctx.agent.deleteSession(session.id);
  }
}
