import { resolve } from 'path';
import { Logger } from '../../utils';
import { decideRefresh, getDomainIntervalSeconds } from './refresh-policy';
import { FreshRssRepository } from './freshrss-repository';
import type { FreshRssFeed, RefreshResult } from './types';

const logger = new Logger('RssRefresh');

export class RssRefreshController {
  constructor(
    private repository: FreshRssRepository,
    private scriptPath = process.env.FRESHRSS_REFRESH_SCRIPT || resolve(import.meta.dir, '../../../scripts/freshrss-refresh-one.php'),
    private containerName = process.env.FRESHRSS_CONTAINER || 'freshrss',
    private user = process.env.FRESHRSS_USER || 'zhang',
  ) {}

  async refreshEligibleFeeds(limit: number, dryRun = false): Promise<RefreshResult[]> {
    const feeds = this.repository.listFeeds();
    const results: RefreshResult[] = [];
    const lastDomainAttempt = new Map<string, number>();

    for (const feed of feeds) {
      if (results.length >= limit) break;
      const state = this.repository.getRefreshState(feed.id, feed.domain);
      const domainState = this.repository.getDomainRefreshState(feed.domain);
      const decision = decideRefresh(feed, mergeRefreshState(state, domainState));
      if (!decision.allowed) {
        continue;
      }

      const lastAttempt = lastDomainAttempt.get(feed.domain) ?? 0;
      const interval = getDomainIntervalSeconds(feed.domain);
      const elapsed = Math.floor(Date.now() / 1000) - lastAttempt;
      if (lastAttempt > 0 && elapsed < interval) {
        await sleep((interval - elapsed) * 1000);
      }

      if (!dryRun) {
        this.repository.recordRefreshAttempt(feed);
      }
      lastDomainAttempt.set(feed.domain, Math.floor(Date.now() / 1000));

      const result = dryRun
        ? this.dryRunResult(feed)
        : await this.refreshOneFeed(feed);
      if (!dryRun) {
        this.repository.recordRefreshResult(result);
      }
      results.push(result);

      logger.info(`刷新 ${feed.name}: ${result.ok ? 'OK' : 'FAIL'} new=${result.newArticles}`);
    }

    return results;
  }

  private async refreshOneFeed(feed: FreshRssFeed): Promise<RefreshResult> {
    const command = `docker exec -i ${shellQuote(this.containerName)} php /dev/stdin --user ${shellQuote(this.user)} --feed-id ${feed.id} < ${shellQuote(this.scriptPath)}`;
    const proc = Bun.spawn(['sh', '-lc', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const parsed = parseRefreshStdout(stdout);
    return {
      feedId: feed.id,
      feedName: feed.name,
      domain: feed.domain,
      skipped: false,
      ok: exitCode === 0 && parsed.ok,
      reason: parsed.reason || (exitCode === 0 ? 'ok' : `exit_${exitCode}`),
      newArticles: parsed.newArticles,
      updatedFeeds: parsed.updatedFeeds,
      stdout,
      stderr,
    };
  }

  private dryRunResult(feed: FreshRssFeed): RefreshResult {
    return {
      feedId: feed.id,
      feedName: feed.name,
      domain: feed.domain,
      skipped: true,
      ok: true,
      reason: 'dry_run',
      newArticles: 0,
      updatedFeeds: 0,
      stdout: '',
      stderr: '',
    };
  }
}

function parseRefreshStdout(stdout: string): { ok: boolean; newArticles: number; updatedFeeds: number; reason: string } {
  const line = stdout.trim().split('\n').find((item) => item.trim().startsWith('{'));
  if (!line) {
    return { ok: false, newArticles: 0, updatedFeeds: 0, reason: 'missing_json_output' };
  }

  try {
    const data = JSON.parse(line);
    return {
      ok: Boolean(data.ok),
      newArticles: Number(data.new_articles ?? 0),
      updatedFeeds: Number(data.updated_feeds ?? 0),
      reason: String(data.reason ?? 'ok'),
    };
  } catch {
    return { ok: false, newArticles: 0, updatedFeeds: 0, reason: 'invalid_json_output' };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeRefreshState<T extends { last_attempt_at: number | null; last_success_at: number | null; consecutive_failures: number; backoff_until: number | null }>(
  feedState: T | null,
  domainState: T | null,
): T | null {
  if (!feedState && !domainState) return null;
  if (!feedState) return domainState;
  if (!domainState) return feedState;

  return {
    ...feedState,
    last_attempt_at: Math.max(feedState.last_attempt_at ?? 0, domainState.last_attempt_at ?? 0) || null,
    last_success_at: Math.max(feedState.last_success_at ?? 0, domainState.last_success_at ?? 0) || null,
    consecutive_failures: Math.max(feedState.consecutive_failures, domainState.consecutive_failures),
    backoff_until: Math.max(feedState.backoff_until ?? 0, domainState.backoff_until ?? 0) || null,
  };
}
