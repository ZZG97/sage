import type { FeedDomain, FreshRssFeed, RefreshDecision } from './types';

const DOMAIN_INTERVAL_SECONDS: Record<FeedDomain, number> = {
  weibo: 45,
  twitter: 30,
  zhihu: 12,
  xueqiu: 12,
  other: 20,
};

const DOMAIN_FAILURE_LIMIT: Record<FeedDomain, number> = {
  weibo: 3,
  twitter: 3,
  zhihu: 5,
  xueqiu: 5,
  other: 5,
};

export interface RefreshState {
  feed_id: number;
  domain: FeedDomain;
  last_attempt_at: number | null;
  last_success_at: number | null;
  consecutive_failures: number;
  backoff_until: number | null;
}

export function detectFeedDomain(url: string): FeedDomain {
  if (url.includes('/weibo/')) return 'weibo';
  if (url.includes('/twitter/') || url.includes('/x/')) return 'twitter';
  if (url.includes('/zhihu/')) return 'zhihu';
  if (url.includes('/xueqiu/')) return 'xueqiu';
  return 'other';
}

export function getDomainIntervalSeconds(domain: FeedDomain): number {
  return DOMAIN_INTERVAL_SECONDS[domain];
}

export function getDomainFailureLimit(domain: FeedDomain): number {
  return DOMAIN_FAILURE_LIMIT[domain];
}

export function decideDomainBackoff(state: RefreshState | null, nowSeconds = Math.floor(Date.now() / 1000)): RefreshDecision {
  if (state?.backoff_until && state.backoff_until > nowSeconds) {
    return {
      allowed: false,
      reason: 'domain_backoff',
      waitSeconds: state.backoff_until - nowSeconds,
    };
  }

  return { allowed: true, reason: 'eligible', waitSeconds: 0 };
}

export function decideRefresh(feed: FreshRssFeed, state: RefreshState | null, nowSeconds = Math.floor(Date.now() / 1000)): RefreshDecision {
  if (feed.error) {
    return { allowed: false, reason: 'feed_marked_error', waitSeconds: 0 };
  }

  if (state?.backoff_until && state.backoff_until > nowSeconds) {
    return {
      allowed: false,
      reason: 'feed_backoff',
      waitSeconds: state.backoff_until - nowSeconds,
    };
  }

  if (state?.last_attempt_at) {
    const elapsed = nowSeconds - state.last_attempt_at;
    const interval = getDomainIntervalSeconds(feed.domain);
    if (elapsed < interval) {
      return {
        allowed: false,
        reason: 'feed_interval',
        waitSeconds: interval - elapsed,
      };
    }
  }

  return { allowed: true, reason: 'eligible', waitSeconds: 0 };
}

export function nextBackoffUntil(domain: FeedDomain, consecutiveFailures: number, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
  if (consecutiveFailures < getDomainFailureLimit(domain)) {
    return null;
  }

  const baseSeconds = domain === 'weibo' ? 1800 : 900;
  const multiplier = Math.min(4, consecutiveFailures - getDomainFailureLimit(domain) + 1);
  return nowSeconds + baseSeconds * multiplier;
}
