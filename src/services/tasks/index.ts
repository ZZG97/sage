// 定时任务注册
import type { Scheduler } from '../scheduler';
import { dailyJournal } from './daily-journal';
import { weeklyConsolidation } from './weekly-consolidation';

export function registerTasks(scheduler: Scheduler): void {
  scheduler.register({
    name: 'daily-journal',
    schedule: { hour: 23, minute: 30 },
    fn: dailyJournal,
  });

  scheduler.register({
    name: 'weekly-consolidation',
    schedule: { hour: 1, minute: 0 },
    fn: weeklyConsolidation,
  });
}
