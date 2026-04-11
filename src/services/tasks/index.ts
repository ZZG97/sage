// 定时任务注册 — 返回 BuiltinTaskDef 列表供 TaskScheduler 使用
import type { BuiltinTaskDef } from '../task-scheduler';
import { dailyJournal } from './daily-journal';
import { weeklyConsolidation } from './weekly-consolidation';
import { eveningGreeting } from './greeting';
import { dailyWeather } from './weather';

/** All built-in scheduled tasks */
export function getBuiltinTasks(): BuiltinTaskDef[] {
  return [
    {
      name: 'daily-weather',
      pattern: '0 8 * * *',     // 每天 08:00
      handler: dailyWeather,
    },
    {
      name: 'daily-journal',
      pattern: '30 23 * * *',   // 每天 23:30
      handler: dailyJournal,
    },
    {
      name: 'weekly-consolidation',
      pattern: '0 1 * * 1',     // 每周一 01:00（cron 原生支持 day-of-week）
      handler: weeklyConsolidation,
    },
    {
      name: 'evening-greeting',
      pattern: '0 18 * * *',    // 每天 18:00
      handler: eveningGreeting,
      allowInDev: true,
    },
  ];
}
