import { QUEUE_NAMES, type QueueName } from '../queue';

/**
 * Where each event type is delivered.
 *
 * In code rather than in the database, and exhaustive rather than dynamic. An
 * `outbox_event` row names a `type`; this is the only thing that turns that name
 * into a queue and a job name, so adding a kind of asynchronous work is a change
 * here and no migration at all.
 *
 * A row whose `type` is absent from this table is unroutable *permanently* — it
 * will not become routable on the next pass — so the dispatcher parks it rather
 * than retrying it. That is a deployment mistake made visible: an event written
 * by a newer API than the worker running beside it.
 */
export const OUTBOX_EVENT_ROUTES = {
  /**
   * A run was accepted and committed with `status = QUEUED`. Phase 2's
   * `AgentWorker` consumes this.
   */
  'agent-run.queued': {
    queue: QUEUE_NAMES.agentExecution,
    jobName: 'execute',
  },
} as const satisfies Record<string, { queue: QueueName; jobName: string }>;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_ROUTES;

export function isRoutableEventType(type: string): type is OutboxEventType {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_ROUTES, type);
}
