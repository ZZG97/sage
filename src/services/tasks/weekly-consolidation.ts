// 定时任务：周记整合 + 记忆整理（触发器，逻辑由 memory skill 执行）
import type { TaskContext } from '../scheduler';

export async function weeklyConsolidation(ctx: TaskContext): Promise<void> {
  // 仅周一执行
  if (new Date().getDay() !== 1) return;

  const session = await ctx.agent.createSession();
  try {
    await ctx.agent.sendMessage(session.id, '请整合本周日记为周记，然后整理记忆');
  } finally {
    await ctx.agent.deleteSession(session.id);
  }
}
