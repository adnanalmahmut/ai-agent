import { describe, expect, it } from '@jest/globals';

import {
  buildRedisConnectionOptions,
  type RedisRole,
} from './redis-connection.options';

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
