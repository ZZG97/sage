import { Hono } from 'hono';
import { InvestmentService } from './service';

function errorResponse(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) };
}

export function createInvestmentRoutes(): Hono {
  const app = new Hono();
  const service = new InvestmentService();

  app.get('/portfolios', (c) => {
    return c.json({ portfolios: service.listPortfolios() });
  });

  app.get('/instruments', (c) => {
    return c.json({ instruments: service.listInstruments() });
  });

  app.get('/portfolios/:id/overview', (c) => {
    try {
      const snapshotRunId = c.req.query('snapshot_run_id') || undefined;
      return c.json(service.getPortfolioOverview(c.req.param('id'), snapshotRunId));
    } catch (error) {
      return c.json(errorResponse(error), 404);
    }
  });

  app.post('/holdings/import', async (c) => {
    try {
      const body = await c.req.json();
      return c.json(service.importHoldings(body), 201);
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  app.post('/portfolios/:id/prices/refresh', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await service.refreshCnAPrices({
        ...body,
        portfolio_id: c.req.param('id'),
      }), 201);
    } catch (error) {
      return c.json(errorResponse(error), 400);
    }
  });

  return app;
}
