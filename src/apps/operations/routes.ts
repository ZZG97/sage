import { Hono } from 'hono';
import { getOperationsService, type OperationStatus } from './service';

const VALID_STATUSES = new Set(['running', 'success', 'warning', 'failed', 'cancelled']);

export function createOperationsRoutes(): Hono {
  const app = new Hono();
  const operations = getOperationsService();

  app.get('/runs', (c) => {
    const statusParam = c.req.query('status');
    const status = statusParam && VALID_STATUSES.has(statusParam)
      ? statusParam as OperationStatus
      : undefined;
    const limit = Number(c.req.query('limit') || 50);
    const operationType = c.req.query('type') || undefined;

    return c.json({
      runs: operations.listRuns({ limit, status, operationType }),
    });
  });

  app.get('/summary', (c) => {
    return c.json(operations.getSummary());
  });

  return app;
}
