import { Hono } from 'hono';
import { DebugService } from './service';

export function createDebugRoutes(): Hono {
  const app = new Hono();
  const service = new DebugService();

  app.get('/databases', (c) => {
    return c.json(service.listDatabases());
  });

  app.get('/tables', (c) => {
    const database = c.req.query('database');
    if (!database) {
      return c.json({ error: 'database 必填' }, 400);
    }

    try {
      return c.json(service.listTables(database));
    } catch (error: any) {
      return c.json({ error: error.message || '加载表失败' }, 400);
    }
  });

  app.get('/rows', (c) => {
    const database = c.req.query('database');
    const table = c.req.query('table');
    const limit = c.req.query('limit');

    if (!database || !table) {
      return c.json({ error: 'database 和 table 必填' }, 400);
    }

    try {
      return c.json(service.getTableRows(database, table, limit ? Number(limit) : undefined));
    } catch (error: any) {
      return c.json({ error: error.message || '查询数据失败' }, 400);
    }
  });

  return app;
}
