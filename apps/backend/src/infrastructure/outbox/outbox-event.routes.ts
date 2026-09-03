import { QUEUE_NAMES, type QueueName } from '../queue';

export const OUTBOX_EVENT_ROUTES = {
  'agent-run.queued': {
    queue: QUEUE_NAMES.agentExecution,
    jobName: 'execute',
  },
  'knowledge-document.ingested': {
    queue: QUEUE_NAMES.knowledgeEmbedding,
    jobName: 'embed',
  },
  'tool-execution.approved': {
    queue: QUEUE_NAMES.toolSideEffect,
    jobName: 'deliver',
  },
} as const satisfies Record<string, { queue: QueueName; jobName: string }>;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_ROUTES;

export const ROUTABLE_EVENT_TYPES: readonly OutboxEventType[] = Object.keys(
  OUTBOX_EVENT_ROUTES,
) as OutboxEventType[];

export function isRoutableEventType(type: string): type is OutboxEventType {
  return Object.prototype.hasOwnProperty.call(OUTBOX_EVENT_ROUTES, type);
}
