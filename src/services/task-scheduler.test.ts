import { Database } from 'bun:sqlite';
import type { JobOptions } from 'bunqueue/client';
import { describe, expect, it } from 'bun:test';
import { runDatabaseMigrations } from '../shared/db-migrations';
import { Logger } from '../utils';
import { DynamicTaskRepository } from './scheduler/dynamic-task-repository';
import type { SchedulerQueue, TaskJobData } from './scheduler/types';
import { TaskScheduler } from './task-scheduler';

class FakeQueue implements SchedulerQueue {
  added: Array<{ name: string; data: TaskJobData; opts?: JobOptions }> = [];
  schedulers: Array<{ id: string; data: TaskJobData; opts?: JobOptions }> = [];
  removedSchedulers: string[] = [];
  removedJobs: string[] = [];
  stallConfig: { enabled: boolean } | null = null;
  failNextRegister = false;
  closed = false;

  setStallConfig(config: { enabled: boolean }): void {
    this.stallConfig = config;
  }

  async add(name: string, data: TaskJobData, opts?: JobOptions): Promise<void> {
    this.failIfNeeded();
    this.added.push({ name, data, opts });
  }

  async upsertJobScheduler(
    id: string,
    _repeatOptions: { pattern: string; timezone: string },
    job: { name: string; data: TaskJobData; opts?: JobOptions },
  ): Promise<void> {
    this.failIfNeeded();
    this.schedulers.push({ id, data: job.data, opts: job.opts });
  }

  async removeJobScheduler(id: string): Promise<void> {
    this.removedSchedulers.push(id);
  }

  async removeAsync(id: string): Promise<void> {
    this.removedJobs.push(id);
  }

  close(): void {
    this.closed = true;
  }

  private failIfNeeded(): void {
    if (!this.failNextRegister) return;
    this.failNextRegister = false;
    throw new Error('register failed');
  }
}

function createSchedulerHarness(): {
  scheduler: TaskScheduler;
  repository: DynamicTaskRepository;
  queue: FakeQueue;
} {
  const db = new Database(':memory:');
  const logger = new Logger('TaskSchedulerTest');
  runDatabaseMigrations('scheduler', db, { logger });
  const repository = new DynamicTaskRepository(db, logger);
  const queue = new FakeQueue();
  const scheduler = new TaskScheduler({
    agent: {} as any,
    logger,
  }, false, { repository, queue, logger });
  return { scheduler, repository, queue };
}

describe('TaskScheduler dynamic tasks', () => {
  it('persists dynamic one-shot tasks and registers them with bunqueue data', async () => {
    const { scheduler, repository, queue } = createSchedulerHarness();
    const triggerAt = Date.now() + 60_000;

    const task = await scheduler.createDynamicTask({
      kind: 'agent',
      message: '  run a check  ',
      title: 'Check',
      context: { reuseConversationId: ' conv_123 ' },
      triggerAt,
    });

    expect(repository.getById(task.id)).toMatchObject({
      id: task.id,
      kind: 'agent',
      message: 'run a check',
      title: 'Check',
      context: { reuseConversationId: 'conv_123' },
      trigger_at: triggerAt,
      status: 'active',
    });
    expect(queue.added).toHaveLength(1);
    expect(queue.added[0].data).toMatchObject({
      type: 'dynamic',
      task_id: task.id,
      kind: 'agent',
      message: 'run a check',
      title: 'Check',
      context: JSON.stringify({ reuseConversationId: 'conv_123' }),
    });
    expect(queue.added[0].opts?.jobId).toBe(`dynamic:${task.id}`);

    await scheduler.stop();
  });

  it('rolls back SQLite changes when refreshing queue registration fails', async () => {
    const { scheduler, repository, queue } = createSchedulerHarness();
    const task = await scheduler.createDynamicTask({
      message: 'first',
      pattern: '0 8 * * *',
    });

    queue.failNextRegister = true;
    await expect(scheduler.updateDynamicTask(task.id, {
      message: 'second',
      pattern: '0 9 * * *',
    })).rejects.toThrow('register failed');

    expect(repository.getById(task.id)).toMatchObject({
      id: task.id,
      message: 'first',
      pattern: '0 8 * * *',
      status: 'active',
    });
    expect(queue.removedSchedulers).toContain(`dynamic:${task.id}`);
    expect(queue.schedulers.at(-1)?.data.message).toBe('first');

    await scheduler.stop();
  });
});
