/**
 * The Redis boundary: per-role connection options and the service that owns
 * the API-process client.
 *
 * One suite because the role semantics are only meaningful through the
 * connection they produce, and the service is the one consumer that proves it.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';

import {
  buildRedisConnectionOptions,
  type RedisRole,
} from '../../../../src/infrastructure/redis/redis.options';
import { RedisService } from '../../../../src/infrastructure/redis/redis.service';

const config = {
  url: 'redis://localhost:6379',
  keyPrefix: 'app:',
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 2_000,
  maxRetriesPerRequest: 2,
};

const ROLES: RedisRole[] = ['general', 'queue-producer', 'queue-worker'];

/**
 * Every assertion here guards a decision whose failure mode is silent.
 *
 * A prefixed worker connection, a timed-out blocking read, an unbounded
 * request-path retry — none of these break a boot or fail a type check. They
 * surface as a worker that "sometimes stops", or requests that hang only while
 * Redis is unwell. Pinning them as tests is the only way the reasoning survives
 * the next edit.
 */
describe('buildRedisConnectionOptions', () => {
  it('points every role at the configured URL with a bounded connect timeout', () => {
    for (const role of ROLES) {
      expect(buildRedisConnectionOptions(role, config)).toMatchObject({
        url: 'redis://localhost:6379',
        connectTimeout: 5_000,
      });
    }
  });

  /**
   * ioredis arms a two-second timer on every `disconnect()` and clears it only
   * when the socket reports `close` — which a socket that never connected never
   * does. On the default, shutting down against an unreachable Redis holds the
   * event loop open for two seconds per connection while waiting for a FIN that
   * is not coming.
   */
  it('bounds a close by the command timeout rather than the ioredis default', () => {
    for (const role of ROLES) {
      expect(buildRedisConnectionOptions(role, config).disconnectTimeout).toBe(
        2_000,
      );
    }

    expect(
      buildRedisConnectionOptions('general', {
        ...config,
        commandTimeoutMs: 250,
      }).disconnectTimeout,
    ).toBe(250);
  });

  it('gives every role a capped, unlimited-attempt reconnection policy', () => {
    for (const role of ROLES) {
      const { retryStrategy } = buildRedisConnectionOptions(role, config);

      // A number for every attempt: reconnection is never abandoned. Returning
      // null or undefined would stop ioredis retrying, leaving a client that
      // needs a process restart to recover from a long outage.
      expect(typeof retryStrategy(1)).toBe('number');
      expect(typeof retryStrategy(1_000)).toBe('number');

      // Backs off, then holds a ceiling rather than growing without bound.
      expect(retryStrategy(1)).toBeLessThan(retryStrategy(5));
      expect(retryStrategy(1_000)).toBe(5_000);
    }
  });

  describe('general (request- and probe-facing)', () => {
    const options = buildRedisConnectionOptions('general', config);

    it('fails commands immediately while disconnected', () => {
      // The actual fast-fail lever. With the offline queue enabled, a command
      // issued during an outage resolves only after a reconnect, so an HTTP
      // handler would wait out the outage instead of being told about it.
      expect(options.enableOfflineQueue).toBe(false);
    });

    it('bounds both the command and the retry budget', () => {
      expect(options.commandTimeout).toBe(2_000);
      expect(options.maxRetriesPerRequest).toBe(2);
    });

    it('is the only role that carries a client-side key prefix', () => {
      expect(options.keyPrefix).toBe('app:');

      expect(
        buildRedisConnectionOptions('queue-producer', config).keyPrefix,
      ).toBeUndefined();
      expect(
        buildRedisConnectionOptions('queue-worker', config).keyPrefix,
      ).toBeUndefined();
    });
  });

  describe('queue-producer (outbox dispatcher)', () => {
    const options = buildRedisConnectionOptions('queue-producer', config);

    /**
     * BullMQ builds key names inside its Lua scripts and never sees a prefix
     * ioredis applies on the way out, so a prefixed connection operates on
     * different keys than its own scripts address. BullMQ v6 throws on such a
     * connection; `QUEUE_PREFIX` is the supported mechanism.
     */
    it('carries no ioredis key prefix', () => {
      expect(options.keyPrefix).toBeUndefined();
    });

    /**
     * The finite budget is what makes the outbox work. A failed publish must
     * return control so the dispatcher can leave the event claimed and retry it
     * on a later pass; with `null` the `add()` would never settle and the loop
     * would never advance.
     */
    it('keeps a finite per-command retry budget so publishing can fail', () => {
      expect(options.maxRetriesPerRequest).toBe(2);
      expect(options.maxRetriesPerRequest).not.toBeNull();
      expect(options.commandTimeout).toBe(2_000);
    });

    it('buffers while reconnecting, unlike the request-facing role', () => {
      // BullMQ issues setup commands as it connects; rejecting those turns a
      // blip into a queue that has to be rebuilt. Still bounded, by the retry
      // budget above.
      expect(options.enableOfflineQueue).toBe(true);
    });
  });

  describe('queue-worker (BullMQ blocking consumer)', () => {
    const options = buildRedisConnectionOptions('queue-worker', config);

    it('carries no ioredis key prefix', () => {
      expect(options.keyPrefix).toBeUndefined();
    });

    /**
     * Mandated by BullMQ. A worker blocks on `BZPOPMIN`/`XREAD` for seconds at
     * a time; under a finite budget those reads count as failed commands and
     * the worker throws instead of polling, so it dies on the first reconnect.
     */
    it('retries indefinitely, as BullMQ requires of a blocking connection', () => {
      expect(options.maxRetriesPerRequest).toBeNull();
    });

    /**
     * The subtlest of the three. A command timeout applies to the blocking
     * reads as well, aborting every long poll on schedule and turning an idle
     * worker into a continuous error stream. This is the one role where an
     * unbounded individual command is correct.
     */
    it('sets no command timeout, which would abort its long polls', () => {
      expect(options.commandTimeout).toBeUndefined();
    });
  });

  it('propagates a changed retry budget to the finite roles only', () => {
    const tightened = { ...config, maxRetriesPerRequest: 1 };

    expect(
      buildRedisConnectionOptions('general', tightened).maxRetriesPerRequest,
    ).toBe(1);
    expect(
      buildRedisConnectionOptions('queue-producer', tightened)
        .maxRetriesPerRequest,
    ).toBe(1);
    expect(
      buildRedisConnectionOptions('queue-worker', tightened)
        .maxRetriesPerRequest,
    ).toBeNull();
  });
});

/**
 * Redis being *unreachable* is the case worth testing without a Redis.
 *
 * It needs no server, it is the state a readiness probe has to describe
 * correctly, and it is the state in which this service's central claim has to
 * hold: an unavailable Redis degrades the process, it does not stop it. So these
 * specs point the client at a closed port on purpose.
 *
 * The reachable path is exercised in `test/e2e/health.e2e-spec.ts`, against the real
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
