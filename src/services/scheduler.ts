// 通用定时任务调度器
import { Logger } from '../utils';
import type { AgentProvider } from '../agent/types';

export interface TaskContext {
  agent: AgentProvider;
  logger: Logger;
}

export interface ScheduledTask {
  name: string;
  schedule: { hour: number; minute: number } | { intervalMs: number };
  fn: (ctx: TaskContext) => Promise<void>;
}

interface TaskState {
  task: ScheduledTask;
  lastRun: number;       // 上次执行时间戳
  lastRunDate: string;   // 上次执行日期 YYYY-MM-DD（用于时间点任务去重）
  running: boolean;
}

export class Scheduler {
  private tasks: Map<string, TaskState> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ctx: TaskContext;
  private logger: Logger;

  constructor(ctx: TaskContext) {
    this.ctx = ctx;
    this.logger = new Logger('Scheduler');
  }

  register(task: ScheduledTask): void {
    this.tasks.set(task.name, {
      task,
      lastRun: 0,
      lastRunDate: '',
      running: false,
    });
    const scheduleDesc = 'hour' in task.schedule
      ? `每天 ${String(task.schedule.hour).padStart(2, '0')}:${String(task.schedule.minute).padStart(2, '0')}`
      : `每 ${task.schedule.intervalMs / 1000}s`;
    this.logger.info(`注册任务: ${task.name} (${scheduleDesc})`);
  }

  unregister(name: string): void {
    this.tasks.delete(name);
    this.logger.info(`注销任务: ${name}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.logger.info(`调度器已启动，${this.tasks.size} 个任务`);
    // 启动后立即检查一次
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logger.info('调度器已停止');
  }

  /** 手动触发某任务（测试用） */
  async runNow(name: string): Promise<void> {
    const state = this.tasks.get(name);
    if (!state) {
      this.logger.warn(`任务不存在: ${name}`);
      return;
    }
    await this.executeTask(state);
  }

  private tick(): void {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const hour = now.getHours();
    const minute = now.getMinutes();

    for (const state of this.tasks.values()) {
      if (state.running) continue;

      const { schedule } = state.task;

      if ('hour' in schedule) {
        // 时间点任务：匹配 hour:minute，同一天只执行一次
        if (schedule.hour === hour && schedule.minute === minute && state.lastRunDate !== today) {
          this.executeTask(state).catch(() => {});
        }
      } else {
        // 间隔任务
        if (Date.now() - state.lastRun >= schedule.intervalMs) {
          this.executeTask(state).catch(() => {});
        }
      }
    }
  }

  private async executeTask(state: TaskState): Promise<void> {
    if (state.running) return;
    state.running = true;

    const { task } = state;
    this.logger.info(`开始执行任务: ${task.name}`);
    const start = Date.now();

    try {
      await task.fn(this.ctx);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      this.logger.info(`任务完成: ${task.name} (${elapsed}s)`);
    } catch (error) {
      this.logger.error(`任务失败: ${task.name}`, error);
    } finally {
      state.lastRun = Date.now();
      state.lastRunDate = new Date().toISOString().split('T')[0];
      state.running = false;
    }
  }
}
