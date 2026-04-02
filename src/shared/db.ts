// 共享数据库连接 — 各 App 通过此模块获取 SQLite 连接
import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { Logger } from '../utils';

const logger = new Logger('SharedDB');

// 数据库连接缓存
const connections = new Map<string, Database>();

/** 获取数据库连接（单例，按路径缓存） */
export function getDatabase(name: string): Database {
  if (connections.has(name)) {
    return connections.get(name)!;
  }

  const dbPath = resolve(import.meta.dir, `../../data/${name}.db`);
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  connections.set(name, db);
  logger.info(`数据库连接已建立: ${name} (${dbPath})`);
  return db;
}

/** 关闭所有数据库连接 */
export function closeAllDatabases(): void {
  for (const [name, db] of connections) {
    try {
      db.close();
      logger.info(`数据库连接已关闭: ${name}`);
    } catch (e) {
      logger.error(`关闭数据库失败: ${name}`, e);
    }
  }
  connections.clear();
}
