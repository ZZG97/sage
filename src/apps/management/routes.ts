// 管理 App — HTTP 路由（provider 切换、fallback 开关、系统状态）
import { Hono } from 'hono';
import type { SageCore } from '../../services/core';

export function createManagementRoutes(sageCore: SageCore): Hono {
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

  return app;
}
