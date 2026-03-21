// 定时任务：每日日记生成（触发器，逻辑由 memory skill 执行）
import type { TaskContext } from '../scheduler';

export async function dailyJournal(ctx: TaskContext): Promise<void> {
  const session = await ctx.agent.createSession();
  try {
    await ctx.agent.sendMessage(session.id, '请总结今天的对话记录，生成日记');
  } finally {
    await ctx.agent.deleteSession(session.id);
  }
}
