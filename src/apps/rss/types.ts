export type FeedDomain = 'weibo' | 'twitter' | 'zhihu' | 'xueqiu' | 'other';

export type RssPriority = 'must_read' | 'skim' | 'skip';

export type RssTopic = 'investment' | 'ai' | 'engineering' | 'macro' | 'life';

export interface FreshRssFeed {
  id: number;
  url: string;
  name: string;
  lastUpdate: number;
  error: number;
  ttl: number;
  domain: FeedDomain;
}

export interface FreshRssEntry {
  id: number;
  guid: string;
  title: string;
  author: string | null;
  content: string | null;
  link: string;
  date: number | null;
  id_feed: number;
  feed_name: string;
  feed_url: string;
  domain: FeedDomain;
}

export interface LabelResult {
  priority: RssPriority;
  topics: RssTopic[];
  confidence: number;
  reason: string;
  fact_or_opinion: 'fact' | 'opinion' | 'mixed' | 'unknown';
  model: string;
}

export interface RefreshDecision {
  allowed: boolean;
  reason: string;
  waitSeconds: number;
}

export interface RefreshResult {
  feedId: number;
  feedName: string;
  domain: FeedDomain;
  skipped: boolean;
  ok: boolean;
  reason: string;
  newArticles: number;
  updatedFeeds: number;
  stdout: string;
  stderr: string;
}

export interface RssWorkerOptions {
  refresh: boolean;
  label: boolean;
  limit: number;
  feedLimit: number;
  sinceHours: number;
  dryRun: boolean;
}
