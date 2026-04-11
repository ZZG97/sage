// 定时任务：每日问候
import type { TaskContext } from '../task-scheduler';

export async function eveningGreeting(ctx: TaskContext): Promise<void> {
  if (!ctx.sendMessageToOwner) {
    ctx.logger.warn('sendMessageToOwner 未注入，跳过问候');
    return;
  }
  await ctx.sendMessageToOwner('晚上好！今天辛苦了 🌙');
}
