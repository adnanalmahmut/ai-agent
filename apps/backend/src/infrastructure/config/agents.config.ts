import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  AGENT_RUN_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(60_000),

  AGENT_RUN_RECONCILE_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(120_000),

  AGENT_RUN_RECONCILE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50),
});

export default registerAs('agents', () => {
  const env = schema.parse(process.env);

  return {
    reconcile: {
      intervalMs: env.AGENT_RUN_RECONCILE_INTERVAL_MS,
      staleAfterMs: env.AGENT_RUN_RECONCILE_STALE_AFTER_MS,
      batchSize: env.AGENT_RUN_RECONCILE_BATCH_SIZE,
    },
  };
});
