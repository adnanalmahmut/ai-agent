import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Agent execution policy that is not queue transport policy.
 *
 * Separate from `queue.config.ts` because the reconciler is an agent-domain
 * component: it decides when an `AgentRun` row is declared dead, which is a
 * business-lifecycle judgement rather than a property of the transport. The
 * queue namespace owns how jobs are delivered and retained; this owns how the
 * application recovers a run the transport gave up on.
 */
const schema = z.object({
  /**
   * How often the reconciler looks for runs the transport has abandoned.
   *
   * This is a recovery loop, not a delivery loop, so it is deliberately far
   * slower than `OUTBOX_POLL_INTERVAL_MS`. Nothing waits on it: the ordinary
   * failure path is written by the handler itself, and this pass only covers
   * the case where BullMQ failed a job without ever invoking the handler.
   */
  AGENT_RUN_RECONCILE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .default(60_000),

  /**
   * How long a run may go without a durable write before it is examined.
   *
   * Purely a cost bound, never a correctness input. A run is only ever failed
   * because BullMQ reports its job terminally `failed`, so a threshold that is
   * too low costs one extra Redis read and a threshold that is too high costs
   * latency — neither can produce a wrong outcome. It exists so a healthy
   * backlog of `QUEUED` runs and a legitimately slow model call are not probed
   * on every pass.
   *
   * It must not be mistaken for a timeout: a run is never failed for taking too
   * long, only for having a job the transport has finished with.
   */
  AGENT_RUN_RECONCILE_STALE_AFTER_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(120_000),

  /** Candidate runs examined per pass. */
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
