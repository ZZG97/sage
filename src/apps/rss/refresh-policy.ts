import type { AdaptiveRefreshDecision, FeedDomain, FeedRefreshStats, FreshRssFeed, RefreshDecision, RefreshTier } from './types';

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

const TIER_INTERVAL_SECONDS: Record<RefreshTier, number> = {
  new: 2 * 3600,
  hot: 2 * 3600,
  normal: 6 * 3600,
  cold: 24 * 3600,
  dormant: 72 * 3600,
};

const DOMAIN_COST_PENALTY: Record<FeedDomain, number> = {
  weibo: 8,
  twitter: 5,
  zhihu: 1,
  xueqiu: 1,
  other: 2,
};

export const EMPTY_FEED_REFRESH_STATS: FeedRefreshStats = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  recentAttempts: 0,
  recentNewArticles: 0,
  recentMustRead: 0,
  recentSkim: 0,
  recentSkip: 0,
  zeroNewStreak: 0,
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

export function decideAdaptiveRefresh(feed: FreshRssFeed, stats: FeedRefreshStats, nowSeconds = Math.floor(Date.now() / 1000)): AdaptiveRefreshDecision {
  const tier = chooseRefreshTier(stats);
  const intervalSeconds = TIER_INTERVAL_SECONDS[tier];
  const lastAttemptAt = stats.lastAttemptAt ?? 0;
  const elapsedSeconds = lastAttemptAt > 0 ? Math.max(0, nowSeconds - lastAttemptAt) : Number.POSITIVE_INFINITY;
  const overdueRatio = intervalSeconds === 0 ? Number.POSITIVE_INFINITY : elapsedSeconds / intervalSeconds;
  const due = lastAttemptAt === 0 || overdueRatio >= 1;
  const qualityScore = stats.recentMustRead * 4 + stats.recentSkim * 1.5 - stats.recentSkip * 0.1;
  const yieldScore = stats.recentNewArticles * 2;
  const overdueScore = Number.isFinite(overdueRatio) ? Math.min(4, overdueRatio) * 25 : 125;
  const learningBoost = tier === 'new' ? (stats.lastAttemptAt ? 150 : 500) : 0;
  const coldPenalty = tier === 'cold' ? 20 : tier === 'dormant' ? 35 : 0;
  const score = Math.round(overdueScore + learningBoost + qualityScore + yieldScore - DOMAIN_COST_PENALTY[feed.domain] - coldPenalty);

  return {
    due,
    tier,
    intervalSeconds,
    overdueRatio: Number.isFinite(overdueRatio) ? Number(overdueRatio.toFixed(3)) : 999,
    score,
    reason: adaptiveReason(tier, stats),
  };
}

function chooseRefreshTier(stats: FeedRefreshStats): RefreshTier {
  if (!stats.lastAttemptAt || stats.recentAttempts < 3) {
    return 'new';
  }

  const qualityHits = stats.recentMustRead * 2 + stats.recentSkim;
  const productive = qualityHits >= 4 || stats.recentNewArticles >= 8;

  if (stats.zeroNewStreak >= 8) {
    return productive ? 'normal' : 'dormant';
  }

  if (stats.zeroNewStreak >= 4) {
    return productive ? 'normal' : 'cold';
  }

  if (productive) {
    return 'hot';
  }

  return 'normal';
}

function adaptiveReason(tier: RefreshTier, stats: FeedRefreshStats): string {
  if (tier === 'new') return 'new_or_learning';
  if (tier === 'hot') return `productive:new=${stats.recentNewArticles},must=${stats.recentMustRead},skim=${stats.recentSkim}`;
  if (tier === 'cold') return `low_yield:zero_streak=${stats.zeroNewStreak}`;
  if (tier === 'dormant') return `dormant:zero_streak=${stats.zeroNewStreak}`;
  return `normal:new=${stats.recentNewArticles},must=${stats.recentMustRead},skim=${stats.recentSkim}`;
}

export function nextBackoffUntil(domain: FeedDomain, consecutiveFailures: number, nowSeconds = Math.floor(Date.now() / 1000)): number | null {
  if (consecutiveFailures < getDomainFailureLimit(domain)) {
    return null;
  }

  const baseSeconds = domain === 'weibo' ? 1800 : 900;
  const multiplier = Math.min(4, consecutiveFailures - getDomainFailureLimit(domain) + 1);
  return nowSeconds + baseSeconds * multiplier;
}
