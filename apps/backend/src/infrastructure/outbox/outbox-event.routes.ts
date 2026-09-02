import { QUEUE_NAMES, type QueueName } from '../queue';

/**
 * Where each event type is delivered.
 *
 * In code rather than in the database, and exhaustive rather than dynamic. An
 * `outbox_event` row names a `type`; this is the only thing that turns that name
 * into a queue and a job name, so adding a kind of asynchronous work is a change
 * here and no migration at all.
 *
 * A row whose `type` is absent from this table is unroutable *by this build*,
 * which is not the same as unroutable. During a rollout the API on the new
 * version writes event types the old worker beside it has never heard of, and a
 * worker that claimed one could only park it — destroying the work before the
 * new worker ever started.
 *
 * So the keys below are also the claim filter: `ROUTABLE_EVENT_TYPES` goes into
 * the `WHERE type IN (...)` of every claim, and an event this build does not
 * understand is left untouched for a process that does.
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
  /**
   * A knowledge document's text was committed and its chunks still need
   * vectors. Written in the same transaction as the chunks, so the work is
   * durable before anything is published.
   */
  'knowledge-document.ingested': {
    queue: QUEUE_NAMES.knowledgeEmbedding,
    jobName: 'embed',
  },
  /**
   * A side-effect proposal was approved. Written in the same transaction as
   * the approval decision and the execution's move to `APPROVED`, with the
   * execution id as the dedupe key. The payload is `{ toolExecutionId,
   * organizationId }` and nothing else — the worker re-reads every fact.
   */
  'tool-execution.approved': {
    queue: QUEUE_NAMES.toolSideEffect,
    jobName: 'deliver',
  },
} as const satisfies Record<string, { queue: QueueName; jobName: string }>;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_ROUTES;

/**
 * The claim filter, derived from the route table rather than restated.
 *
 * Two lists would drift, and the drift is silent in the dangerous direction: a
 * type present in the filter but missing from the routes is claimed by a worker
 * that cannot deliver it.
 */
export const ROUTABLE_EVENT_TYPES: readonly OutboxEventType[] = Object.keys(
  OUTBOX_EVENT_ROUTES,
) as OutboxEventType[];

export function isRoutableEventType(type: string): type is OutboxEventType {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_ROUTES, type);
}
