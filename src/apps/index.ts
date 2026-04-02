// App 注册表 — 所有 App 在此注册，统一挂载到 Hono
import { Hono } from 'hono';
import { Logger } from '../utils';
import { createHealthRoutes } from './health/routes';

const logger = new Logger('Apps');

interface AppDefinition {
  name: string;
  path: string;
  createRoutes: () => Hono;
}

// 注册所有 App
const apps: AppDefinition[] = [
  { name: 'health', path: '/apps/health', createRoutes: createHealthRoutes },
];

/** 将所有 App 路由挂载到主 Hono 实例 */
export function mountApps(rootApp: Hono): void {
  for (const app of apps) {
    const routes = app.createRoutes();
    rootApp.route(app.path, routes);
    logger.info(`App 已挂载: ${app.name} → ${app.path}`);
  }
  logger.info(`共挂载 ${apps.length} 个 App`);
}
