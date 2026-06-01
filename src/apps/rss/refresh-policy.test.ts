import { describe, expect, it } from 'bun:test';
import { decideAdaptiveRefresh, decideRefresh } from './refresh-policy';
import type { FeedRefreshStats, FreshRssFeed } from './types';

const BASE_FEED: FreshRssFeed = {
  id: 7,
  url: 'http://host.docker.internal:1200/xueqiu/user/2292705444',
  name: 'metalslime',
  lastUpdate: 0,
  error: 1,
  ttl: 0,
  domain: 'xueqiu',
};

describe('decideRefresh', () => {
  it('retries feeds even when FreshRSS still marks them as error', () => {
    const decision = decideRefresh(BASE_FEED, null, 1_000);
    expect(decision).toEqual({
      allowed: true,
      reason: 'eligible',
      waitSeconds: 0,
    });
  });

  it('still respects sidecar backoff for failing feeds', () => {
    const decision = decideRefresh(BASE_FEED, {
      feed_id: BASE_FEED.id,
      domain: BASE_FEED.domain,
      last_attempt_at: 900,
      last_success_at: 800,
      consecutive_failures: 5,
      backoff_until: 1_200,
    }, 1_000);

    expect(decision).toEqual({
      allowed: false,
      reason: 'feed_backoff',
      waitSeconds: 200,
    });
  });
});

describe('decideAdaptiveRefresh', () => {
  const BASE_STATS: FeedRefreshStats = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    recentAttempts: 0,
    recentNewArticles: 0,
    recentMustRead: 0,
    recentSkim: 0,
    recentSkip: 0,
    zeroNewStreak: 0,
  };

  it('refreshes new feeds immediately while they are still learning', () => {
    const decision = decideAdaptiveRefresh(BASE_FEED, BASE_STATS, 10_000);

    expect(decision.due).toBe(true);
    expect(decision.tier).toBe('new');
    expect(decision.intervalSeconds).toBe(2 * 3600);
  });

  it('promotes productive feeds to hot cadence', () => {
    const decision = decideAdaptiveRefresh(BASE_FEED, {
      ...BASE_STATS,
      lastAttemptAt: 10_000 - 2 * 3600 - 1,
      lastSuccessAt: 9_000,
      recentAttempts: 5,
      recentNewArticles: 2,
      recentMustRead: 2,
    }, 10_000);

    expect(decision.due).toBe(true);
    expect(decision.tier).toBe('hot');
    expect(decision.reason).toContain('productive');
  });

  it('demotes feeds with a long zero-new streak', () => {
    const decision = decideAdaptiveRefresh(BASE_FEED, {
      ...BASE_STATS,
      lastAttemptAt: 1_000_000 - 24 * 3600,
      lastSuccessAt: 900_000,
      recentAttempts: 10,
      recentNewArticles: 2,
      zeroNewStreak: 8,
    }, 1_000_000);

    expect(decision.due).toBe(false);
    expect(decision.tier).toBe('dormant');
    expect(decision.intervalSeconds).toBe(72 * 3600);
  });

  it('keeps recently empty but historically productive feeds on normal cadence', () => {
    const decision = decideAdaptiveRefresh(BASE_FEED, {
      ...BASE_STATS,
      lastAttemptAt: 1_000_000 - 6 * 3600 - 1,
      lastSuccessAt: 900_000,
      recentAttempts: 10,
      recentNewArticles: 42,
      zeroNewStreak: 5,
    }, 1_000_000);

    expect(decision.due).toBe(true);
    expect(decision.tier).toBe('normal');
    expect(decision.intervalSeconds).toBe(6 * 3600);
  });
});
