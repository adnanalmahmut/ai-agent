import type { ConfigType } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

import type { redisConfig } from '../../config';

/**
 * What a Redis connection is *for*.
 *
 * These are not three copies of one client with cosmetic differences. Each role
 * has a failure mode that is correct for it and catastrophic for the others, so
 * the options are derived from the role rather than shared and patched:
 *
 *   general         Serves HTTP requests and health probes. Must fail fast:
 *                   a handler that waits on coordination state is strictly
 *                   worse than one that gives up and reads PostgreSQL.
 *   queue-producer  Publishes from the outbox dispatcher. Must fail *and
 *                   return*, so the dispatcher can leave the event claimed and
 *                   retry it on the next pass instead of blocking the loop.
 *   queue-worker    BullMQ's blocking consumer. Must never give up, and must
 *                   never have its blocking reads timed out.
 */
export type RedisRole = 'general' | 'queue-producer' | 'queue-worker';

/**
 * Reconnection policy shared by every role.
 *
 * Exponential with a ceiling, and no attempt limit. The limit that matters is
 * `maxRetriesPerRequest`, which bounds how long an individual *command* waits;
 * capping reconnection attempts as well would mean a client that permanently
 * stopped trying after a long outage and then required a process restart to
 * recover.
 */
const reconnectAfter = (attempt: number): number =>
  Math.min(50 * 2 ** Math.min(attempt, 7), 5_000);

/**
 * Turns a role into ioredis options.
 *
 * A pure function, deliberately: the decisions below are the ones most likely
 * to be quietly undone by a later edit, and this way each of them is a unit
 * test rather than a code review comment.
 */
export function buildRedisConnectionOptions(
  role: RedisRole,
  config: ConfigType<typeof redisConfig>,
): RedisOptions & { url: string } {
  const base: RedisOptions & { url: string } = {
    url: config.url,
    connectTimeout: config.connectTimeoutMs,
    retryStrategy: reconnectAfter,
    enableReadyCheck: true,
    /**
     * How long a close waits for the socket to end before destroying it.
     *
     * Stated rather than inherited. ioredis defaults this to two seconds and
     * arms the timer on every `disconnect()`, clearing it only when the socket
     * reports `close` — which a socket that never finished connecting does not
     * do. Shutting down against an unreachable Redis therefore holds the event
     * loop open for two seconds per connection on the default, for no benefit:
     * `quit()` has already drained whatever replies existed, so this bounds
     * nothing but the wait for a FIN that is not coming.
     *
     * Tied to the command timeout because that is the same judgement — how long
     * this service is willing to wait on a Redis that is not answering.
     */
    disconnectTimeout: config.commandTimeoutMs,
  };

  switch (role) {
    case 'general':
      return {
        ...base,
        /**
         * The only role that gets a client-side key prefix. Safe here because
         * no BullMQ machinery ever touches this connection.
         */
        keyPrefix: config.keyPrefix,
        commandTimeout: config.commandTimeoutMs,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        /**
         * The actual fast-fail lever. With the offline queue enabled, a command
         * issued while disconnected is buffered and resolves only after a
         * reconnect — so an HTTP handler would wait on the outage rather than
         * being told about it. Disabled, the command rejects at once and the
         * caller can fall back to PostgreSQL or report degradation.
         */
        enableOfflineQueue: false,
      };

    case 'queue-producer':
      return {
        ...base,
        /**
         * No `keyPrefix`. BullMQ computes key names inside its Lua scripts and
         * never sees a prefix ioredis adds on the way out, so a prefixed
         * connection reads and writes different keys than its scripts assume.
         * BullMQ v6 throws rather than allowing it; `QUEUE_PREFIX` is the
         * supported mechanism.
         */
        commandTimeout: config.commandTimeoutMs,
        /**
         * Finite, and that is the whole point. A failed publish has to hand
         * control back to the dispatcher, which then leaves the outbox event
         * claimed until its lease expires and re-publishes on a later pass.
         * With `null` here the `add()` would never settle, the loop would never
         * advance, and the durability the outbox exists to provide would be
         * traded for an unbounded await.
         */
        maxRetriesPerRequest: config.maxRetriesPerRequest,
        /**
         * Left enabled, unlike the general role. BullMQ issues its own setup
         * commands while connecting, and rejecting those turns a momentary
         * blip into a queue that has to be reconstructed. Bounded by
         * `maxRetriesPerRequest` above, so this cannot wait forever.
         */
        enableOfflineQueue: true,
      };

    case 'queue-worker':
      return {
        ...base,
        /**
         * Mandated by BullMQ for the blocking consumer. A worker blocks on
         * `BZPOPMIN`/`XREAD` for seconds at a time; with a finite budget those
         * reads are counted as failed commands and the worker throws instead of
         * polling, which crashes it on the first reconnect.
         */
        maxRetriesPerRequest: null,
        /**
         * Deliberately absent: `commandTimeout`.
         *
         * It would apply to the blocking reads too, aborting every long poll at
         * the timeout and turning normal idling into a continuous error stream.
         * This is the one role where an unbounded individual command is the
         * correct behaviour rather than an oversight.
         */
        enableOfflineQueue: true,
      };
  }
}
