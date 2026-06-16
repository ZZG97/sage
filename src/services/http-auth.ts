import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export interface HttpAuthConfig {
  required: boolean;
  tokens: string[];
  cookieName: string;
}

const PROTECTED_PREFIXES = [
  '/apps/debug',
  '/apps/health',
  '/apps/investment',
  '/apps/management',
  '/apps/operations',
  '/test',
  '/uploads',
];

const PROTECTED_CHILD_PREFIXES = [
  '/scheduler',
];

const PROTECTED_EXACT_PATHS = [
  '/cleanup',
  '/health',
  '/status',
];

const AUTH_SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

export function isProtectedHttpPath(path: string): boolean {
  if (PROTECTED_EXACT_PATHS.includes(path)) return true;
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
    || PROTECTED_CHILD_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`));
}

export function isHttpAuthConfigured(config: HttpAuthConfig): boolean {
  return config.tokens.length > 0;
}

export function isHttpAuthEnabled(config: HttpAuthConfig): boolean {
  return config.required || isHttpAuthConfigured(config);
}

export function getBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() || null;
}

export function isAllowedHttpToken(token: string | null | undefined, config: HttpAuthConfig): boolean {
  if (!token) return false;
  return config.tokens.includes(token);
}

function requestToken(c: Context, config: HttpAuthConfig): string | null {
  return getBearerToken(c.req.header('Authorization')) ?? getCookie(c, config.cookieName) ?? null;
}

function unauthorized(c: Context) {
  return c.json({
    error: 'UNAUTHORIZED',
    message: 'Sage HTTP token is required',
  }, 401);
}

function authNotConfigured(c: Context) {
  return c.json({
    error: 'AUTH_NOT_CONFIGURED',
    message: 'SAGE_HTTP_AUTH_REQUIRED is enabled but no Sage HTTP token is configured',
  }, 503);
}

export function createHttpAuthMiddleware(config: HttpAuthConfig): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    if (!isProtectedHttpPath(c.req.path) || !isHttpAuthEnabled(config)) {
      await next();
      return;
    }

    if (!isHttpAuthConfigured(config)) {
      return authNotConfigured(c);
    }

    if (!isAllowedHttpToken(requestToken(c, config), config)) {
      return unauthorized(c);
    }

    await next();
  };
}

export function registerHttpAuthRoutes(app: Hono, config: HttpAuthConfig): void {
  app.get('/auth/status', (c) => {
    const configured = isHttpAuthConfigured(config);
    const enabled = isHttpAuthEnabled(config);
    return c.json({
      authRequired: enabled,
      configured,
      authenticated: !enabled || (configured && isAllowedHttpToken(requestToken(c, config), config)),
    });
  });

  app.post('/auth/session', async (c) => {
    if (!isHttpAuthEnabled(config)) {
      return c.json({ success: true, authRequired: false });
    }

    if (!isHttpAuthConfigured(config)) {
      return authNotConfigured(c);
    }

    const body = await c.req.json().catch(() => ({})) as { token?: unknown };
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!isAllowedHttpToken(token, config)) {
      return unauthorized(c);
    }

    setCookie(c, config.cookieName, token, {
      httpOnly: true,
      maxAge: AUTH_SESSION_MAX_AGE_SEC,
      path: '/',
      sameSite: 'Strict',
    });

    return c.json({ success: true, authRequired: true });
  });

  app.delete('/auth/session', (c) => {
    deleteCookie(c, config.cookieName, {
      path: '/',
      sameSite: 'Strict',
    });
    return c.json({ success: true });
  });
}
