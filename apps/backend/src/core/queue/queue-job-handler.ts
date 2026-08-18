import type { Job } from 'bullmq';

import type { QueueName } from './queue.constants';

/**
 * Everything a queue consumer has to do, and nothing else.
 *
 * One method. No `onFailed`, no `shouldRetry`, no lifecycle callbacks: retry
 * policy is a queue-level decision that belongs to configuration, and failure
 * recording is a durable write that belongs to PostgreSQL. A handler that could
 * override either would make those policies advisory.
 *
 * The contract a handler must honour, which the runner cannot enforce for it:
 *
 * - Be safe to run twice. Delivery is at-least-once by construction — a
 *   dispatcher that dies between publishing and recording delivery re-publishes,
 *   and a worker killed mid-job has its job recovered as stalled. A handler that
 *   is not idempotent turns both of those normal events into duplicated side
 *   effects.
 * - Treat cancellation as a business decision read from the database, never as
 *   something inferred from the process shutting down.
 */
export interface QueueJobHandler<TData = unknown> {
  readonly queue: QueueName;

  /**
   * The BullMQ job name this handler answers to.
   *
   * Explicit so one queue can carry several kinds of work without a handler
   * having to inspect the payload to discover whether the job is its own.
   */
  readonly jobName: string;

  handle(job: Job<TData>): Promise<void>;
}
