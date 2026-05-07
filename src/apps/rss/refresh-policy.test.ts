import { describe, expect, it } from 'bun:test';
import { decideRefresh } from './refresh-policy';
import type { FreshRssFeed } from './types';

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
