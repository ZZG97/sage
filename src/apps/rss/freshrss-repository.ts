import { Database } from 'bun:sqlite';
import { resolve } from 'path';
import { getDatabase } from '../../shared/db';
import { detectFeedDomain, nextBackoffUntil, type RefreshState } from './refresh-policy';
import type { FeedDomain, FreshRssEntry, FreshRssFeed, LabelResult, RefreshResult } from './types';

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

    return rows.map((row) => ({
      ...row,
      domain: detectFeedDomain(row.url),
    }));
  }

  listUnprocessedEntries(sinceHours = 48, limit = 50): FreshRssEntry[] {
    const sinceSeconds = Math.floor(Date.now() / 1000) - sinceHours * 3600;
    const rows = this.freshDb.prepare(`
      SELECT e.id, e.guid, e.title, e.author, e.content, e.link, e.date, e.id_feed, f.name AS feed_name, f.url AS feed_url
      FROM entry e
      JOIN feed f ON f.id = e.id_feed
      WHERE COALESCE(e.date, 0) >= ?
      ORDER BY e.id DESC
      LIMIT ?
    `).all(sinceSeconds, Math.max(limit * 20, 200)) as EntryRow[];

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

  applyLabelResult(entry: FreshRssEntry, result: LabelResult, labels: string[], contentHash: string, dryRun = false): void {
    if (dryRun) {
      return;
    }

    const apply = this.freshDb.transaction(() => {
      for (const label of labels) {
        this.freshDb.prepare('INSERT OR IGNORE INTO tag (name, attributes) VALUES (?, NULL)').run(label);
      }

      const priorityTagIds = this.freshDb.prepare(`
        SELECT id FROM tag WHERE name IN ('AI·必读', 'AI·可看', 'AI·略过')
      `).all() as { id: number }[];
      for (const tag of priorityTagIds) {
        this.freshDb.prepare('DELETE FROM entrytag WHERE id_tag = ? AND id_entry = ?').run(tag.id, entry.id);
      }

      for (const label of labels) {
        const tag = this.freshDb.prepare('SELECT id FROM tag WHERE name = ?').get(label) as { id: number } | null;
        if (!tag) continue;
        this.freshDb.prepare('INSERT OR IGNORE INTO entrytag (id_tag, id_entry) VALUES (?, ?)').run(tag.id, entry.id);
      }
    });

    apply();
    this.recordProcessed(entry, result, labels, contentHash, false);
  }

  getRefreshState(feedId: number, domain: FeedDomain): RefreshState | null {
    return this.sidecarDb.prepare(`
      SELECT feed_id, domain, last_attempt_at, last_success_at, consecutive_failures, backoff_until
      FROM feed_refresh_state
      WHERE feed_id = ? AND domain = ?
    `).get(feedId, domain) as RefreshState | null;
  }

  getDomainRefreshState(domain: FeedDomain): RefreshState | null {
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
      GROUP BY domain
    `).get(domain) as RefreshState | null;
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
        confidence, reason, fact_or_opinion, model, dry_run, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
      ON CONFLICT(entry_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        priority = excluded.priority,
        topics_json = excluded.topics_json,
        labels_json = excluded.labels_json,
        confidence = excluded.confidence,
        reason = excluded.reason,
        fact_or_opinion = excluded.fact_or_opinion,
        model = excluded.model,
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
      dryRun ? 1 : 0,
    );
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
