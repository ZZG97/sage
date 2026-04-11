// 定时任务：周记整合 + 记忆整理（触发器，逻辑由 memory skill 执行）
// Cron pattern "0 1 * * 1" ensures Monday-only execution — no manual day check needed.
import type { TaskContext } from '../task-scheduler';

export async function weeklyConsolidation(ctx: TaskContext): Promise<void> {
  const session = await ctx.agent.createSession();
  try {
    await ctx.agent.sendMessage(session.id, '请整合本周日记为周记，然后整理记忆');
  } finally {
    await ctx.agent.deleteSession(session.id);
  }
}
