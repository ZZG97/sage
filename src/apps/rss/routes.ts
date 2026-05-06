import { Hono } from 'hono';
import { FreshRssRepository } from './freshrss-repository';
import { renderAiRssFeed } from './feed-renderer';
import type { RssPriority } from './types';

const AI_FEEDS: Array<{
  path: string;
  priority: RssPriority;
  title: string;
  description: string;
}> = [
  {
    path: '/feeds/ai-must-read.xml',
    priority: 'must_read',
    title: 'Sage AI·必读',
    description: 'Sage 从 RSSHub 信息流中筛出的高优先级内容，含 AI 摘要、判断理由和原文链接。',
  },
  {
    path: '/feeds/ai-skim.xml',
    priority: 'skim',
    title: 'Sage AI·可看',
    description: 'Sage 从 RSSHub 信息流中筛出的中优先级内容，适合有空快速浏览。',
  },
  {
    path: '/feeds/ai-skip.xml',
    priority: 'skip',
    title: 'Sage AI·略过',
    description: 'Sage 从 RSSHub 信息流中判定为低优先级的内容，用于抽查和调校筛选质量。',
  },
];

export function createRssRoutes(): Hono {
  const app = new Hono();
  const repository = new FreshRssRepository();

  for (const feed of AI_FEEDS) {
    app.get(feed.path, (c) => {
      const limit = parseBoundedInt(c.req.query('limit'), 1, 100, 50);
      const sinceHours = parseBoundedInt(c.req.query('sinceHours'), 1, 24 * 30, 24 * 7);
      const items = repository.listAiFeedItems({
        priority: feed.priority,
        sinceHours,
        limit,
      });
      const selfUrl = new URL(c.req.url);
      const xml = renderAiRssFeed(items, {
        title: feed.title,
        description: feed.description,
        selfUrl: selfUrl.toString(),
      });

      return c.body(xml, 200, {
        'Content-Type': 'application/rss+xml; charset=UTF-8',
        'Cache-Control': 'no-cache',
      });
    });
  }

  return app;
}

function parseBoundedInt(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
