/**
 * Every queue this service owns, named once.
 *
 * A queue name is a Redis key fragment shared by a producer in one process and
 * a consumer in another, so a typo does not fail — it creates a second, empty
 * queue that nothing ever drains. Naming them here makes that class of mistake
 * a compile error.
 */
export const QUEUE_NAMES = {
  /** Asynchronous agent execution: one job per `AgentRun` attempt. */
  agentExecution: 'agent-execution',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * Injection token for the job handlers a worker process should run.
 *
 * A token holding an array, rather than each handler injected individually, so
 * the worker entrypoint does not have to change shape every time a queue gains
 * a consumer — and so an API process can wire the empty array and be
 * structurally incapable of consuming jobs.
 */
export const QUEUE_JOB_HANDLERS = Symbol('QUEUE_JOB_HANDLERS');
