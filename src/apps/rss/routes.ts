import { Hono } from 'hono';
import { FreshRssRepository } from './freshrss-repository';
import { renderAiRssFeed } from './feed-renderer';

export function createRssRoutes(): Hono {
  const app = new Hono();
  const repository = new FreshRssRepository();

  app.get('/feeds/ai-must-read.xml', (c) => {
    const limit = parseBoundedInt(c.req.query('limit'), 1, 100, 50);
    const sinceHours = parseBoundedInt(c.req.query('sinceHours'), 1, 24 * 30, 24 * 7);
    const items = repository.listAiFeedItems({
      priority: 'must_read',
      sinceHours,
      limit,
    });
    const selfUrl = new URL(c.req.url);
    const xml = renderAiRssFeed(items, {
      title: 'Sage AI·必读',
      description: 'Sage 从 RSSHub 信息流中筛出的高优先级内容，含 AI 摘要、判断理由和原文链接。',
      selfUrl: selfUrl.toString(),
    });

    return c.body(xml, 200, {
      'Content-Type': 'application/rss+xml; charset=UTF-8',
      'Cache-Control': 'no-cache',
    });
  });

  return app;
}

function parseBoundedInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

