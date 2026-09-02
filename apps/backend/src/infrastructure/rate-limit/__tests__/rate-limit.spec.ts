import { describe, expect, it, jest } from '@jest/globals';

import type { RedisService } from '../../redis';
import {
  normalSubject,
  normalizedRouteTemplate,
} from '../rate-limit.interceptor';
import {
  RedisRateLimiterAdapter,
  SLIDING_WINDOW_SCRIPT,
} from '../redis-rate-limiter.adapter';

describe('RedisRateLimiterAdapter', () => {
  it('passes keys and values separately to one atomic Lua script', async () => {
    const evalCommand = jest.fn((...args: unknown[]) => {
      void args;
      return Promise.resolve([1, 2, 61_000]);
    });
    const redis = {
      connection: { eval: evalCommand },
    } as unknown as RedisService;
    const limiter = new RedisRateLimiterAdapter(redis);

    await expect(
      limiter.consume({
        key: 'normal:GET:/files/:id:user:u1',
        points: 3,
        durationSec: 60,
        requestId: 'request-1',
        nowMs: 1_000,
      }),
    ).resolves.toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetAtMs: 61_000,
    });

    expect(evalCommand).toHaveBeenCalledWith(
      SLIDING_WINDOW_SCRIPT,
      1,
      'rl:v1:normal:GET:/files/:id:user:u1',
      1_000,
      60_000,
      3,
      '1000:request-1',
    );
    expect(SLIDING_WINDOW_SCRIPT).toContain('return {0, 0, resetAt}');
    expect(SLIDING_WINDOW_SCRIPT).not.toContain('MULTI');
  });

  it('maps a rejection without inventing reset metadata', async () => {
    const redis = {
      connection: { eval: () => Promise.resolve([0, 0, 12_345]) },
    } as unknown as RedisService;

    await expect(
      new RedisRateLimiterAdapter(redis).consume({
        key: 'key',
        points: 1,
        durationSec: 10,
        requestId: 'request-2',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
      resetAtMs: 12_345,
    });
  });
});

describe('rate limit request identity', () => {
  it('uses the normalized Express route template instead of raw URL values', () => {
    expect(
      normalizedRouteTemplate({
        method: 'get',
        baseUrl: '/files',
        path: '/01928',
        route: { path: '/:id' },
      }),
    ).toBe('GET:/files/:id');
  });

  it('prioritizes user, then session, then canonical req.ip', () => {
    expect(
      normalSubject({
        method: 'GET',
        user: { id: 'u1' },
        session: { id: 's1' },
        ip: '8.8.8.8',
      }),
    ).toBe('user:u1');
    expect(
      normalSubject({ method: 'GET', session: { id: 's1' }, ip: '8.8.8.8' }),
    ).toBe('session:s1');
    expect(normalSubject({ method: 'GET', ip: '8.8.8.8' })).toBe('ip:8.8.8.8');
  });
});
