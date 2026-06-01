import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { getDatabase } from '../../shared/db';
import { decideAdaptiveRefresh, detectFeedDomain, EMPTY_FEED_REFRESH_STATS, nextBackoffUntil, type RefreshState } from './refresh-policy';
import type { FeedDomain, FeedRefreshCandidate, FeedRefreshStats, FreshRssEntry, FreshRssFeed, LabelResult, RefreshResult, RssPriority } from './types';

const GENERATED_FEED_URL_MARKER = '/apps/rss/feeds/';

interface EntryRow {
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
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toFreshRssFeed(row: Omit<FreshRssFeed, 'domain'>): FreshRssFeed {
  return {
    ...row,
    domain: detectFeedDomain(row.url),
  };
}

function isSageGeneratedFeedUrl(url: string): boolean {
  return url.includes(GENERATED_FEED_URL_MARKER);
}

export interface AiFeedItem {
  entry_id: number;
  feed_id: number;
  feed_name: string;
  title: string;
  author: string | null;
  link: string;
  content: string | null;
  published_at: number | null;
  priority: RssPriority;
  labels: string[];
  topics: string[];
  confidence: number;
  summary: string | null;
  reason: string;
  fact_or_opinion: string;
  model: string;
  processed_at: string;
}

export class FreshRssRepository {
  private freshDb: Database;
  private sidecarDb: Database;

  constructor(private freshRssDbPath = process.env.FRESHRSS_DB_PATH || '/Users/zhangzhiguo/deploy/freshrss/data/users/zhang/db.sqlite') {
    this.freshDb = new Database(resolve(freshRssDbPath));
    this.freshDb.exec('PRAGMA busy_timeout = 5000');
    this.freshDb.exec('PRAGMA foreign_keys = ON');
    this.sidecarDb = getDatabase('rss-ai');
    this.initSidecarSchema();
  }

  listFeeds(limit = 1000): FreshRssFeed[] {
    const rows = this.freshDb.prepare(`
      SELECT id, url, name, lastUpdate, error, ttl
      FROM feed
      ORDER BY lastUpdate ASC, id ASC
      LIMIT ?
    `).all(limit) as Omit<FreshRssFeed, 'domain'>[];

    return rows.map(toFreshRssFeed);
  }

  listInputFeeds(limit = 1000): FreshRssFeed[] {
    return this.listFeeds(limit).filter((feed) => !isSageGeneratedFeedUrl(feed.url));
  }

  listInputRefreshCandidates(limit = 1000): FeedRefreshCandidate[] {
    const feeds = this.listInputFeeds(limit);
    const statsByFeedId = this.loadFeedRefreshStats(feeds.map((feed) => feed.id));
    const now = Math.floor(Date.now() / 1000);

    return feeds
      .map((feed) => {
        const stats = statsByFeedId.get(feed.id) ?? emptyFeedRefreshStats();
        return {
          feed,
          stats,
          policy: decideAdaptiveRefresh(feed, stats, now),
        };
      })
      .sort((a, b) => {
        if (a.policy.due !== b.policy.due) return a.policy.due ? -1 : 1;
        if (a.policy.score !== b.policy.score) return b.policy.score - a.policy.score;
        return (a.stats.lastAttemptAt ?? 0) - (b.stats.lastAttemptAt ?? 0);
      });
  }

  listGeneratedFeeds(limit = 1000): FreshRssFeed[] {
    return this.listFeeds(limit).filter((feed) => isSageGeneratedFeedUrl(feed.url));
  }

  getFeedsByIds(feedIds: number[]): FreshRssFeed[] {
    if (feedIds.length === 0) return [];

    const uniqueIds = [...new Set(feedIds)];
    const placeholders = uniqueIds.map(() => '?').join(',');
    const rows = this.freshDb.prepare(`
      SELECT id, url, name, lastUpdate, error, ttl
      FROM feed
      WHERE id IN (${placeholders})
    `).all(...uniqueIds) as Omit<FreshRssFeed, 'domain'>[];
    const feedsById = new Map(rows.map((row) => [row.id, toFreshRssFeed(row)]));

    return uniqueIds.flatMap((id) => {
      const feed = feedsById.get(id);
      return feed ? [feed] : [];
    });
  }

  listUnprocessedEntries(sinceHours = 48, limit = 50): FreshRssEntry[] {
    const sinceSeconds = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    const rows = this.freshDb.prepare(`
      SELECT e.id, e.guid, e.title, e.author, e.content, e.link, e.date, e.id_feed, f.name AS feed_name, f.url AS feed_url
      FROM entry e
      JOIN feed f ON f.id = e.id_feed
      WHERE COALESCE(e.date, 0) >= ?
        AND f.url NOT LIKE ?
      ORDER BY e.id DESC
      LIMIT ?
    `).all(sinceSeconds, `%${GENERATED_FEED_URL_MARKER}%`, Math.max(limit * 20, 200)) as EntryRow[];

    const processedStmt = this.sidecarDb.prepare('SELECT content_hash, dry_run FROM processed_entries WHERE entry_id = ?');
    const entries: FreshRssEntry[] = [];
    for (const row of rows) {
      const processed = processedStmt.get(row.id) as { content_hash: string; dry_run: number } | null;
      if (processed && processed.dry_run === 0) continue;
      entries.push({
        ...row,
        domain: detectFeedDomain(row.feed_url),
      });
      if (entries.length >= limit) break;
    }
    return entries;
  }

  recordAiResult(entry: FreshRssEntry, result: LabelResult, labels: string[], contentHash: string, dryRun = false): void {
    if (dryRun) {
      return;
    }
    this.recordProcessed(entry, result, labels, contentHash, false);
  }

  listAiFeedItems(options: { priority: RssPriority; sinceHours: number; limit: number }): AiFeedItem[] {
    const since = new Date(Date.now() - options.sinceHours * 3600 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const processedRows = this.sidecarDb.prepare(`
      SELECT
        entry_id,
        feed_id,
        priority,
        topics_json,
        labels_json,
        confidence,
        reason,
        fact_or_opinion,
        model,
        summary,
        processed_at
      FROM processed_entries
      WHERE dry_run = 0
        AND priority = ?
        AND processed_at >= ?
      ORDER BY processed_at DESC, entry_id DESC
      LIMIT ?
    `).all(options.priority, since, options.limit) as Array<{
      entry_id: number;
      feed_id: number;
      priority: RssPriority;
      topics_json: string;
      labels_json: string;
      confidence: number;
      reason: string;
      fact_or_opinion: string;
      model: string;
      summary: string | null;
      processed_at: string;
    }>;

    if (processedRows.length === 0) return [];

    const entryIds = processedRows.map((row) => row.entry_id);
    const placeholders = entryIds.map(() => '?').join(',');
    const entryRows = this.freshDb.prepare(`
      SELECT e.id, e.title, e.author, e.content, e.link, e.date, e.id_feed, f.name AS feed_name
      FROM entry e
      JOIN feed f ON f.id = e.id_feed
      WHERE e.id IN (${placeholders})
    `).all(...entryIds) as Array<{
      id: number;
      title: string;
      author: string | null;
      content: string | null;
      link: string;
      date: number | null;
      id_feed: number;
      feed_name: string;
    }>;
    const entriesById = new Map(entryRows.map((entry) => [entry.id, entry]));

    return processedRows.flatMap((row) => {
      const entry = entriesById.get(row.entry_id);
      if (!entry) return [];
      return [{
        entry_id: row.entry_id,
        feed_id: row.feed_id,
        feed_name: entry.feed_name,
        title: entry.title,
        author: entry.author,
        link: entry.link,
        content: entry.content,
        published_at: entry.date,
        priority: row.priority,
        labels: parseJsonArray(row.labels_json),
        topics: parseJsonArray(row.topics_json),
        confidence: row.confidence,
        summary: row.summary,
        reason: row.reason,
        fact_or_opinion: row.fact_or_opinion,
        model: row.model,
        processed_at: row.processed_at,
      }];
    });
  }

  getRefreshState(feedId: number, domain: FeedDomain): RefreshState | null {
    return this.sidecarDb.prepare(`
      SELECT feed_id, domain, last_attempt_at, last_success_at, consecutive_failures, backoff_until
      FROM feed_refresh_state
      WHERE feed_id = ? AND domain = ?
    `).get(feedId, domain) as RefreshState | null;
  }

  getDomainRefreshState(domain: FeedDomain): RefreshState | null {
    const generatedFeedIds = this.listGeneratedFeeds().map((feed) => feed.id);
    const generatedFilter = generatedFeedIds.length > 0
      ? `AND feed_id NOT IN (${generatedFeedIds.map(() => '?').join(',')})`
      : '';

    return this.sidecarDb.prepare(`
      SELECT
        0 AS feed_id,
        domain,
        MAX(last_attempt_at) AS last_attempt_at,
        MAX(last_success_at) AS last_success_at,
        MAX(consecutive_failures) AS consecutive_failures,
        MAX(backoff_until) AS backoff_until
      FROM feed_refresh_state
      WHERE domain = ?
        ${generatedFilter}
      GROUP BY domain
    `).get(domain, ...generatedFeedIds) as RefreshState | null;
  }

  recordRefreshAttempt(feed: FreshRssFeed): void {
    const now = Math.floor(Date.now() / 1000);
    this.sidecarDb.prepare(`
      INSERT INTO feed_refresh_state (feed_id, domain, last_attempt_at, consecutive_failures, updated_at)
      VALUES (?, ?, ?, 0, datetime('now', 'localtime'))
      ON CONFLICT(feed_id, domain) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        updated_at = excluded.updated_at
    `).run(feed.id, feed.domain, now);
  }

  recordRefreshResult(result: RefreshResult): void {
    const now = Math.floor(Date.now() / 1000);
    const state = this.getRefreshState(result.feedId, result.domain);
    const failures = result.ok ? 0 : (state?.consecutive_failures ?? 0) + 1;
    const backoffUntil = result.ok ? null : nextBackoffUntil(result.domain, failures, now);
    this.sidecarDb.prepare(`
      INSERT INTO feed_refresh_state (
        feed_id, domain, last_attempt_at, last_success_at, consecutive_failures, backoff_until, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(feed_id, domain) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        consecutive_failures = excluded.consecutive_failures,
        backoff_until = excluded.backoff_until,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      result.feedId,
      result.domain,
      now,
      result.ok ? now : state?.last_success_at ?? null,
      failures,
      backoffUntil,
      result.ok ? null : `${result.reason}\n${result.stderr}`.slice(0, 1000),
    );

    this.sidecarDb.prepare(`
      INSERT INTO refresh_runs (feed_id, feed_name, domain, ok, new_articles, updated_feeds, reason, stdout, stderr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.feedId,
      result.feedName,
      result.domain,
      result.ok ? 1 : 0,
      result.newArticles,
      result.updatedFeeds,
      result.reason,
      result.stdout.slice(0, 4000),
      result.stderr.slice(0, 4000),
    );
  }

  private recordProcessed(entry: FreshRssEntry, result: LabelResult, labels: string[], contentHash: string, dryRun: boolean): void {
    this.sidecarDb.prepare(`
      INSERT INTO processed_entries (
        entry_id, feed_id, guid, link, content_hash, priority, topics_json, labels_json,
        confidence, reason, fact_or_opinion, model, summary, dry_run, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(entry_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        priority = excluded.priority,
        topics_json = excluded.topics_json,
        labels_json = excluded.labels_json,
        confidence = excluded.confidence,
        reason = excluded.reason,
        fact_or_opinion = excluded.fact_or_opinion,
        model = excluded.model,
        summary = excluded.summary,
        dry_run = excluded.dry_run,
        processed_at = excluded.processed_at
    `).run(
      entry.id,
      entry.id_feed,
      entry.guid,
      entry.link,
      contentHash,
      result.priority,
      JSON.stringify(result.topics),
      JSON.stringify(labels),
      result.confidence,
      result.reason,
      result.fact_or_opinion,
      result.model,
      result.summary ?? null,
      dryRun ? 1 : 0,
    );
  }

  private loadFeedRefreshStats(feedIds: number[]): Map<number, FeedRefreshStats> {
    const statsByFeedId = new Map<number, FeedRefreshStats>();
    for (const feedId of feedIds) {
      statsByFeedId.set(feedId, emptyFeedRefreshStats());
    }
    if (feedIds.length === 0) return statsByFeedId;

    const placeholders = feedIds.map(() => '?').join(',');

    const stateRows = this.sidecarDb.prepare(`
      SELECT feed_id, MAX(last_attempt_at) AS last_attempt_at, MAX(last_success_at) AS last_success_at
      FROM feed_refresh_state
      WHERE feed_id IN (${placeholders})
      GROUP BY feed_id
    `).all(...feedIds) as Array<{ feed_id: number; last_attempt_at: number | null; last_success_at: number | null }>;
    for (const row of stateRows) {
      const stats = statsByFeedId.get(row.feed_id);
      if (!stats) continue;
      stats.lastAttemptAt = row.last_attempt_at;
      stats.lastSuccessAt = row.last_success_at;
    }

    const runRows = this.sidecarDb.prepare(`
      SELECT
        feed_id,
        COUNT(*) AS recent_attempts,
        COALESCE(SUM(CASE WHEN ok = 1 THEN new_articles ELSE 0 END), 0) AS recent_new_articles
      FROM refresh_runs
      WHERE feed_id IN (${placeholders})
        AND created_at >= datetime('now', 'localtime', '-14 days')
      GROUP BY feed_id
    `).all(...feedIds) as Array<{ feed_id: number; recent_attempts: number; recent_new_articles: number }>;
    for (const row of runRows) {
      const stats = statsByFeedId.get(row.feed_id);
      if (!stats) continue;
      stats.recentAttempts = Number(row.recent_attempts);
      stats.recentNewArticles = Number(row.recent_new_articles);
    }

    const recentRuns = this.sidecarDb.prepare(`
      SELECT feed_id, ok, new_articles
      FROM refresh_runs
      WHERE feed_id IN (${placeholders})
      ORDER BY feed_id ASC, id DESC
    `).all(...feedIds) as Array<{ feed_id: number; ok: number; new_articles: number }>;
    const seenRunCountByFeedId = new Map<number, number>();
    for (const row of recentRuns) {
      const seen = seenRunCountByFeedId.get(row.feed_id) ?? 0;
      if (seen >= 12) continue;
      seenRunCountByFeedId.set(row.feed_id, seen + 1);
      const stats = statsByFeedId.get(row.feed_id);
      if (!stats) continue;
      if (row.ok === 1 && row.new_articles === 0) {
        stats.zeroNewStreak += 1;
      } else if (row.new_articles > 0) {
        seenRunCountByFeedId.set(row.feed_id, 12);
      }
    }

    const aiRows = this.sidecarDb.prepare(`
      SELECT
        feed_id,
        COALESCE(SUM(CASE WHEN priority = 'must_read' THEN 1 ELSE 0 END), 0) AS must_read_count,
        COALESCE(SUM(CASE WHEN priority = 'skim' THEN 1 ELSE 0 END), 0) AS skim_count,
        COALESCE(SUM(CASE WHEN priority = 'skip' THEN 1 ELSE 0 END), 0) AS skip_count
      FROM processed_entries
      WHERE feed_id IN (${placeholders})
        AND dry_run = 0
        AND processed_at >= datetime('now', 'localtime', '-14 days')
      GROUP BY feed_id
    `).all(...feedIds) as Array<{ feed_id: number; must_read_count: number; skim_count: number; skip_count: number }>;
    for (const row of aiRows) {
      const stats = statsByFeedId.get(row.feed_id);
      if (!stats) continue;
      stats.recentMustRead = Number(row.must_read_count);
      stats.recentSkim = Number(row.skim_count);
      stats.recentSkip = Number(row.skip_count);
    }

    return statsByFeedId;
  }

  private initSidecarSchema(): void {
    this.sidecarDb.exec(`
      CREATE TABLE IF NOT EXISTS processed_entries (
        entry_id INTEGER PRIMARY KEY,
        feed_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        link TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        priority TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        fact_or_opinion TEXT NOT NULL,
        model TEXT NOT NULL,
        dry_run INTEGER NOT NULL DEFAULT 0,
        cluster_id TEXT,
        author_key TEXT,
        summary TEXT,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_rss_processed_feed ON processed_entries(feed_id);
      CREATE INDEX IF NOT EXISTS idx_rss_processed_priority ON processed_entries(priority);
      CREATE INDEX IF NOT EXISTS idx_rss_processed_at ON processed_entries(processed_at);

      CREATE TABLE IF NOT EXISTS feed_refresh_state (
        feed_id INTEGER NOT NULL,
        domain TEXT NOT NULL,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until INTEGER,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (feed_id, domain)
      );

      CREATE TABLE IF NOT EXISTS refresh_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_id INTEGER NOT NULL,
        feed_name TEXT NOT NULL,
        domain TEXT NOT NULL,
        ok INTEGER NOT NULL,
        new_articles INTEGER NOT NULL,
        updated_feeds INTEGER NOT NULL,
        reason TEXT NOT NULL,
        stdout TEXT NOT NULL,
        stderr TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_rss_refresh_runs_feed ON refresh_runs(feed_id);
      CREATE INDEX IF NOT EXISTS idx_rss_refresh_runs_created ON refresh_runs(created_at);
    `);
  }
}

function emptyFeedRefreshStats(): FeedRefreshStats {
  return { ...EMPTY_FEED_REFRESH_STATS };
}
