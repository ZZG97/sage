// 定时任务注册 — 返回 BuiltinTaskDef 列表供 TaskScheduler 使用
import type { BuiltinTaskDef } from '../task-scheduler';
import { dailyJournal } from './daily-journal';
import { weeklyConsolidation } from './weekly-consolidation';
import { eveningGreeting } from './greeting';
import { dailyWeather } from './weather';
import { syncSystemPrompts } from './system-prompt-sync';
import { operationsHealthCheck } from './operations-health';

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
    {
      name: 'system-prompt-sync',
      pattern: '10 3 * * *',     // 每天 03:10 同步 Claude Code / Codex 系统提示
      handler: syncSystemPrompts,
    },
    {
      name: 'operations-health-check',
      pattern: '0 */6 * * *',     // 每 6 小时扫描统一任务运行账本
      handler: operationsHealthCheck,
    },
  ];
}
