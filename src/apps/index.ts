// App 注册表 — 所有 App 在此注册，统一挂载到 Hono
import { Hono } from 'hono';
import { Logger } from '../utils';
import { createHealthRoutes } from './health/routes';
import { createManagementRoutes } from './management/routes';
import type { SageCore } from '../services/core';

const logger = new Logger('Apps');

/** App 上下文，由 WebServer 传入 */
export interface AppContext {
  sageCore: SageCore;
}

interface AppDefinition {
  name: string;
  path: string;
  createRoutes: (ctx: AppContext) => Hono;
}

// 注册所有 App
const apps: AppDefinition[] = [
  { name: 'health', path: '/apps/health', createRoutes: () => createHealthRoutes() },
  { name: 'management', path: '/apps/management', createRoutes: (ctx) => createManagementRoutes(ctx.sageCore) },
];

/** 将所有 App 路由挂载到主 Hono 实例 */
export function mountApps(rootApp: Hono, ctx: AppContext): void {
  for (const app of apps) {
    const routes = app.createRoutes(ctx);
    rootApp.route(app.path, routes);
    logger.info(`App 已挂载: ${app.name} → ${app.path}`);
  }
  logger.info(`共挂载 ${apps.length} 个 App`);
}
