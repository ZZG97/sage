// 健康管理 App — HTTP 路由
import { Hono } from 'hono';
import { HealthService } from './service';

export function createHealthRoutes(): Hono {
  const app = new Hono();
  const service = new HealthService();

  // 统计概览
  app.get('/stats', (c) => {
    return c.json(service.getStats());
  });

  // 看病记录列表
  app.get('/records', (c) => {
    const query = {
      department: c.req.query('department'),
      diagnosis: c.req.query('diagnosis'),
      date_from: c.req.query('date_from'),
      date_to: c.req.query('date_to'),
      keyword: c.req.query('keyword'),
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
      offset: c.req.query('offset') ? Number(c.req.query('offset')) : undefined,
    };
    // 清除 undefined 值
    const cleaned = Object.fromEntries(Object.entries(query).filter(([_, v]) => v !== undefined));
    return c.json(service.listRecords(cleaned));
  });

  // 单条记录详情（含指标和用药）
  app.get('/records/:id', (c) => {
    const record = service.getRecord(Number(c.req.param('id')));
    if (!record) return c.json({ error: '记录不存在' }, 404);
    return c.json(record);
  });

  // 创建记录
  app.post('/records', async (c) => {
    const body = await c.req.json();
    if (!body.visit_date) return c.json({ error: 'visit_date 必填' }, 400);
    const record = service.createRecord(body);
    return c.json(record, 201);
  });

  // 更新记录
  app.put('/records/:id', async (c) => {
    const body = await c.req.json();
    const record = service.updateRecord(Number(c.req.param('id')), body);
    if (!record) return c.json({ error: '记录不存在' }, 404);
    return c.json(record);
  });

  // 删除记录
  app.delete('/records/:id', (c) => {
    const ok = service.deleteRecord(Number(c.req.param('id')));
    if (!ok) return c.json({ error: '记录不存在' }, 404);
    return c.json({ success: true });
  });

  // 给某条记录添加检查指标
  app.post('/records/:id/metrics', async (c) => {
    const metrics = await c.req.json();
    if (!Array.isArray(metrics)) return c.json({ error: '需要数组格式' }, 400);
    const result = service.addMetrics(Number(c.req.param('id')), metrics);
    return c.json(result, 201);
  });

  // 指标趋势
  app.get('/metrics/trend/:name', (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 20;
    return c.json(service.getMetricTrend(c.req.param('name'), limit));
  });

  // 在用药物
  app.get('/medications/active', (c) => {
    return c.json(service.getActiveMedications());
  });

  // 添加用药
  app.post('/medications', async (c) => {
    const body = await c.req.json();
    if (!body.medication_name) return c.json({ error: 'medication_name 必填' }, 400);
    return c.json(service.addMedication(body), 201);
  });

  // 停药
  app.post('/medications/:id/stop', (c) => {
    const ok = service.stopMedication(Number(c.req.param('id')));
    if (!ok) return c.json({ error: '记录不存在' }, 404);
    return c.json({ success: true });
  });

  return app;
}
