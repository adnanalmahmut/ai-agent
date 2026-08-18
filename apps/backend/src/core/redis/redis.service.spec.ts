import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';

import { RedisService } from './redis.service';

/**
 * Redis being *unreachable* is the case worth testing without a Redis.
 *
 * It needs no server, it is the state a readiness probe has to describe
 * correctly, and it is the state in which this service's central claim has to
 * hold: an unavailable Redis degrades the process, it does not stop it. So these
 * specs point the client at a closed port on purpose.
 *
 * The reachable path is exercised in `test/redis.e2e-spec.ts`, against the real
 * instance CI provides — asserting a successful round trip against a mock would
 * assert nothing.
 */
describe('RedisService (Redis unreachable)', () => {
  // Chosen to be closed rather than merely unused: 9 is TCP discard, which
  // nothing in this project's compose stack or CI ever binds.
  const unreachable = {
    url: 'redis://127.0.0.1:9',
    keyPrefix: 'test:',
    connectTimeoutMs: 150,
    commandTimeoutMs: 150,
    maxRetriesPerRequest: 1,
  };

  // Held as standalone spies rather than read back off the object, so the
  // assertions never pass an unbound method around.
  const info = jest.fn();
  const warn = jest.fn();
  const logger = { info, warn, error: jest.fn() } as unknown as PinoLogger;

  let service: RedisService | undefined;

  const create = () => {
    service = new RedisService(unreachable, logger);
    return service;
  };

  /** Gives the event loop a bounded number of ticks to satisfy a condition. */
  const eventually = async (
    condition: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;

    while (!condition() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
  });

  afterEach(async () => {
    // Not tidiness: the reconnection policy never gives up by design, so an
    // unclosed client keeps a timer alive and the runner never exits.
    await service?.onApplicationShutdown();
    service = undefined;
  });

  /**
   * The single most important property of this service. The API must be able to
   * answer `GET /health/live` while Redis is down, which it cannot do if
   * constructing the client throws or blocks.
   */
  it('constructs without connecting, throwing, or blocking', () => {
    expect(() => create()).not.toThrow();
  });

  it('reports the connection as not ready', () => {
    const redis = create();

    expect(redis.isReady).toBe(false);
    expect(redis.hasEverConnected).toBe(false);
  });

  it('probes down rather than rejecting', async () => {
    // A readiness endpoint has to be able to call this unconditionally. A probe
    // that throws would make the handler responsible for Redis' failure modes.
    await expect(create().probe()).resolves.toEqual({ status: 'down' });
  });

  it('probes within its own timeout instead of waiting out the outage', async () => {
    const redis = create();
    const startedAt = Date.now();

    await redis.probe();

    // Bounded well under any orchestrator probe timeout. The exact figure is
    // not the assertion — "it returns rather than hangs" is.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  /**
   * ioredis emits `error` on every failed connection attempt, and an
   * EventEmitter with no `error` listener throws. Without the handler this
   * service installs, an unreachable Redis would crash the process — the exact
   * opposite of the degradation it exists to provide.
   */
  it('absorbs connection errors instead of letting them go unhandled', async () => {
    create();

    // The refusal arrives on the socket, not on the probe: with the offline
    // queue disabled the probe has already failed and returned by the time
    // ioredis reports ECONNREFUSED. Both halves matter — the fast answer and
    // the error that does not reach the process.
    await eventually(() => warn.mock.calls.length > 0);

    expect(warn).toHaveBeenCalled();
  });

  /**
   * A shutdown step that rejects strands every step after it, and `quit()` does
   * reject when there is no server to quit.
   */
  it('shuts down cleanly even though quit cannot succeed', async () => {
    const redis = create();

    await expect(redis.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('is safe to shut down twice', async () => {
    const redis = create();

    await redis.onApplicationShutdown();

    await expect(redis.onApplicationShutdown()).resolves.toBeUndefined();
  });
});
