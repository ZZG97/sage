// 管理 App — HTTP 路由（provider 切换、fallback 开关、系统状态）
import { Hono } from 'hono';
import type { SageCore } from '../../services/core';
import type { DynamicTaskWriteOptions, TaskScheduler } from '../../services/task-scheduler';

function parseDynamicTaskBody(body: any): DynamicTaskWriteOptions {
  const kind = body.kind === 'workflow'
    ? 'workflow'
    : body.kind === 'agent'
      ? 'agent'
      : 'message';
  const workflow = body.workflow ?? body.payload;
  const content = kind === 'workflow'
    ? (body.message ?? body.description ?? '')
    : (body.message ?? body.prompt);

  if (kind !== 'workflow' && !content) {
    throw new Error('message (or prompt for kind=agent) is required');
  }

  return {
    kind,
    message: content ?? '',
    title: body.title ?? body.topic,
    payload: workflow,
    pattern: body.pattern,
    triggerAt: body.triggerAt,
  };
}

export function registerSchedulerRoutes(app: Hono, scheduler: TaskScheduler): void {
  // 内置任务列表
  app.get('/scheduler/builtin', (c) => {
    return c.json({ tasks: scheduler.listBuiltinTasks() });
  });

  // 手动触发内置任务
  app.post('/scheduler/builtin/:name/run', async (c) => {
    const name = c.req.param('name');
    try {
      await scheduler.runNow(name);
      return c.json({ success: true, task: name });
    } catch (error) {
      return c.json({ success: false, error: String(error) }, 500);
    }
  });

  // 动态任务列表
  app.get('/scheduler/tasks', (c) => {
    const all = c.req.query('all') === 'true';
    return c.json({ tasks: scheduler.listDynamicTasks(all) });
  });

  // 创建动态任务
  app.post('/scheduler/tasks', async (c) => {
    try {
      const body = await c.req.json();
      const task = await scheduler.createDynamicTask(parseDynamicTaskBody(body));
      return c.json({ success: true, task });
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  // 更新动态任务
  app.patch('/scheduler/tasks/:id', async (c) => {
    const id = c.req.param('id');
    try {
      const body = await c.req.json();
      const task = await scheduler.updateDynamicTask(id, parseDynamicTaskBody(body));
      if (!task) {
        return c.json({ error: 'task not found' }, 404);
      }
      return c.json({ success: true, task });
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  });

  // 删除动态任务
  app.delete('/scheduler/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const ok = await scheduler.removeDynamicTask(id);
    if (!ok) {
      return c.json({ error: 'task not found' }, 404);
    }
    return c.json({ success: true });
  });
}

export function createManagementRoutes(sageCore: SageCore, scheduler: TaskScheduler): Hono {
  const app = new Hono();

  // 系统状态
  app.get('/status', (c) => {
    return c.json({
      ...sageCore.getStatus(),
      ...sageCore.getProviderInfo(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Provider 列表和状态
  app.get('/providers', (c) => {
    return c.json(sageCore.getProviderInfo());
  });

  // 切换活跃 provider
  app.post('/providers/active', async (c) => {
    const { name } = await c.req.json<{ name: string }>();
    if (!name) return c.json({ error: 'name 必填' }, 400);

    const ok = sageCore.switchProvider(name);
    if (!ok) {
      const info = sageCore.getProviderInfo();
      return c.json({
        error: `未知 provider: ${name}`,
        available: info.availableProviders,
      }, 400);
    }

    return c.json({ success: true, activeProvider: name });
  });

  // 设置自动降级
  app.post('/fallback', async (c) => {
    const { enabled } = await c.req.json<{ enabled: boolean }>();
    if (typeof enabled !== 'boolean') return c.json({ error: 'enabled 必须为 boolean' }, 400);

    sageCore.setAutoFallback(enabled);
    return c.json({ success: true, autoFallbackEnabled: enabled });
  });

  registerSchedulerRoutes(app, scheduler);

  return app;
}
