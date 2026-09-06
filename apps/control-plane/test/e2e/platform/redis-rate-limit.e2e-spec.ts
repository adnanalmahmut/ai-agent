import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { RateLimiterPort } from '../../../src/infrastructure/rate-limit';
import { createHarness, type Harness } from '../../support/auth-harness';

describe('Redis exact sliding-window limiter', () => {
  let harness: Harness;
  let limiter: RateLimiterPort;

  beforeAll(async () => {
    harness = await createHarness();
    limiter = harness.app.get(RateLimiterPort);
  });

  afterAll(async () => {
    await harness.close();
  });

  it('never allows more than points under concurrent consumption', async () => {
    const key = `concurrency:${Date.now()}`;
    const decisions = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        limiter.consume({
          key,
          points: 5,
          durationSec: 60,
          requestId: `parallel-${index}`,
        }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(20);
  });

  it('expires individual requests on a rolling window', async () => {
    const key = `rolling:${Date.now()}`;
    const first = await limiter.consume({
      key,
      points: 1,
      durationSec: 1,
      requestId: 'first',
    });
    const blocked = await limiter.consume({
      key,
      points: 1,
      durationSec: 1,
      requestId: 'blocked',
    });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const afterExpiry = await limiter.consume({
      key,
      points: 1,
      durationSec: 1,
      requestId: 'after-expiry',
    });

    expect(first.allowed).toBe(true);
    expect(blocked.allowed).toBe(false);
    expect(afterExpiry.allowed).toBe(true);
  });
});
