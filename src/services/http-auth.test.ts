import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import {
  createHttpAuthMiddleware,
  getBearerToken,
  isProtectedHttpPath,
  registerHttpAuthRoutes,
  type HttpAuthConfig,
} from './http-auth';

function createTestApp(config: HttpAuthConfig): Hono {
  const app = new Hono();
  app.use('*', createHttpAuthMiddleware(config));
  registerHttpAuthRoutes(app, config);
  app.get('/apps/management/status', (c) => c.json({ ok: true }));
  app.get('/scheduler', (c) => c.text('spa'));
  app.get('/scheduler/tasks', (c) => c.json({ ok: true }));
  app.get('/uploads/images/a.png', (c) => c.text('image'));
  app.get('/apps/rss/feeds/ai-must-read.xml', (c) => c.text('rss'));
  app.get('/health-dashboard', (c) => c.text('spa'));
  return app;
}

describe('http auth', () => {
  const config: HttpAuthConfig = {
    required: true,
    tokens: ['admin-token', 'internal-token'],
    cookieName: 'sage_http_token',
  };

  it('classifies private and public paths', () => {
    expect(isProtectedHttpPath('/apps/management/status')).toBe(true);
    expect(isProtectedHttpPath('/scheduler')).toBe(false);
    expect(isProtectedHttpPath('/scheduler/tasks')).toBe(true);
    expect(isProtectedHttpPath('/uploads/images/a.png')).toBe(true);
    expect(isProtectedHttpPath('/health')).toBe(true);
    expect(isProtectedHttpPath('/health-dashboard')).toBe(false);
    expect(isProtectedHttpPath('/apps/rss/feeds/ai-must-read.xml')).toBe(false);
  });

  it('parses bearer tokens', () => {
    expect(getBearerToken('Bearer internal-token')).toBe('internal-token');
    expect(getBearerToken('bearer admin-token')).toBe('admin-token');
    expect(getBearerToken('Basic abc')).toBeNull();
    expect(getBearerToken(undefined)).toBeNull();
  });

  it('rejects protected paths without a token', async () => {
    const app = createTestApp(config);
    const response = await app.request('/scheduler/tasks');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'UNAUTHORIZED' });
  });

  it('allows the scheduler SPA route while protecting scheduler APIs', async () => {
    const app = createTestApp(config);
    expect((await app.request('/scheduler')).status).toBe(200);
    expect((await app.request('/scheduler/tasks')).status).toBe(401);
  });

  it('accepts protected paths with a bearer token', async () => {
    const app = createTestApp(config);
    const response = await app.request('/apps/management/status', {
      headers: { Authorization: 'Bearer internal-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('sets a session cookie that can authorize uploads', async () => {
    const app = createTestApp(config);
    const sessionResponse = await app.request('/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token' }),
    });
    expect(sessionResponse.status).toBe(200);
    const cookie = sessionResponse.headers.get('set-cookie');
    expect(cookie).toContain('sage_http_token=admin-token');

    const uploadResponse = await app.request('/uploads/images/a.png', {
      headers: { Cookie: cookie ?? '' },
    });
    expect(uploadResponse.status).toBe(200);
    expect(await uploadResponse.text()).toBe('image');
  });

  it('leaves RSS feeds and SPA pages public', async () => {
    const app = createTestApp(config);
    expect((await app.request('/apps/rss/feeds/ai-must-read.xml')).status).toBe(200);
    expect((await app.request('/health-dashboard')).status).toBe(200);
  });

  it('fails closed when auth is required but no tokens are configured', async () => {
    const app = createTestApp({ required: true, tokens: [], cookieName: 'sage_http_token' });
    const response = await app.request('/apps/debug/databases');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'AUTH_NOT_CONFIGURED' });
  });

  it('stays disabled when auth is not required and no tokens are configured', async () => {
    const app = createTestApp({ required: false, tokens: [], cookieName: 'sage_http_token' });
    const response = await app.request('/scheduler/tasks');
    expect(response.status).toBe(200);
  });
});
