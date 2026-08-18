import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.url(),

  /**
   * How long acquiring a pooled connection may take before the query fails.
   *
   * `node-postgres` defaults this to zero, which means *wait forever*, and the
   * consequences are not theoretical: with an unreachable database every query
   * hangs instead of failing, so the readiness probe that is supposed to report
   * the outage never answers, and a shutdown sequence waiting on a query in
   * flight never finishes. A bounded wait turns all of those into a prompt,
   * legible error.
   */
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(5_000),
});

export default registerAs('database', () => {
  const env = schema.parse(process.env);
  return {
    url: env.DATABASE_URL,
    connectTimeoutMs: env.DATABASE_CONNECT_TIMEOUT_MS,
  };
});
