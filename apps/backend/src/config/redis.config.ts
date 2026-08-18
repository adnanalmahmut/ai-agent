import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Connection settings for Redis, which in this service is coordination
 * infrastructure and never a system of record.
 *
 * The division of labour is deliberate and worth stating where it is
 * configured, because it is the assumption every consumer inherits:
 *
 *   PostgreSQL  Authoritative, durable, recoverable. Agent runs, steps, tool
 *               executions and LLM call records live only here. Losing Redis
 *               entirely must never lose an agent run.
 *   Redis       Ephemeral coordination. Stream buffers, partial state,
 *               rate-limit windows, short-lived locks, and BullMQ's own queue
 *               structures. Everything here is either reconstructible from
 *               PostgreSQL or cheap to lose.
 *
 * The timeouts below exist because of the first half of that split. A request
 * path that blocks indefinitely on coordination state is strictly worse than
 * one that fails fast and falls back to the database, so nothing is allowed to
 * wait without a bound.
 */
const schema = z.object({
  /**
   * Required with no default, exactly like `DATABASE_URL`.
   *
   * A localhost default would be a production footgun of a specific kind:
   * the worker would start, connect to nothing, and log connection retries
   * forever while queued work silently accumulated in the outbox. A missing
   * variable should stop the process instead.
   */
  REDIS_URL: z.url({
    protocol: /^rediss?$/,
    error: 'REDIS_URL must be a redis:// or rediss:// URL',
  }),

  /**
   * Namespace for this application's *own* keys — stream buffers, rate-limit
   * windows, idempotency markers.
   *
   * Explicitly not BullMQ's namespace. BullMQ keys are prefixed through its
   * own `prefix` option (see `queue.config.ts`); applying an ioredis
   * `keyPrefix` to a connection BullMQ uses corrupts its Lua scripts, which
   * compute key names themselves and never see the prefix ioredis adds.
   * BullMQ v6 refuses such a connection outright, and that refusal is a
   * feature worth not working around.
   */
  REDIS_KEY_PREFIX: z
    .string()
    .regex(
      /^[A-Za-z0-9_:-]+$/,
      'REDIS_KEY_PREFIX may contain only letters, digits, "_", ":" and "-"',
    )
    .default('app'),

  /** How long a fresh TCP connection may take to become usable. */
  REDIS_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),

  /**
   * How long any single command may take.
   *
   * Bounded low on purpose: an HTTP handler reading coordination state should
   * give up long before the client's own timeout, so a stalled Redis degrades
   * latency rather than exhausting the request pool.
   */
  REDIS_COMMAND_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(2_000),

  /**
   * Retry budget for a single command on the finite-retry connections.
   *
   * Capped at 3 rather than left open. `null` here would mean "retry forever",
   * which is correct for a BullMQ worker's blocking connection and wrong for
   * everything else: in a request handler it converts a Redis outage into
   * hung requests, and in the outbox dispatcher it prevents control from ever
   * returning so the event can be left for the next pass. The worker's `null`
   * is set in the connection layer, not here, precisely so it cannot be
   * applied to the wrong role by editing an environment variable.
   */
  REDIS_MAX_RETRIES_PER_REQUEST: z.coerce
    .number()
    .int()
    .min(1)
    .max(3)
    .default(2),
});

export default registerAs('redis', () => {
  const env = schema.parse(process.env);

  return {
    url: env.REDIS_URL,
    /**
     * Trailing colon applied once, here, so no caller has to remember it and
     * no two callers can disagree about it.
     */
    keyPrefix: `${env.REDIS_KEY_PREFIX}:`,
    connectTimeoutMs: env.REDIS_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: env.REDIS_COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: env.REDIS_MAX_RETRIES_PER_REQUEST,
  };
});
