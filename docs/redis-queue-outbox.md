# Redis, queue, and outbox

Redis holds coordination state: BullMQ, sliding-window rate limits, probes, and
future short-lived coordination. Production enables AOF with `noeviction`, but
Redis is never the system of record.

Connections are provisioned by role. Request-facing/general commands have
bounded timeouts, finite retries, and no offline queue. Queue producers return
after bounded failure so outbox work remains claimable. Worker blocking
connections retry indefinitely as BullMQ requires.

```mermaid
sequenceDiagram
  participant API
  participant DB as PostgreSQL
  participant O as Outbox dispatcher
  participant Q as BullMQ/Redis
  API->>DB: transaction: business row + outbox_event
  DB-->>API: commit
  O->>DB: claim routable rows under lease
  O->>Q: queue.add(dedupe jobId)
  O->>DB: mark delivered
```

A crash between publish and mark-delivered produces a duplicate after lease
expiry. Consumers must therefore be idempotent through PostgreSQL constraints;
BullMQ job IDs are only an optimization. Unknown publish failures retry with
capped backoff, while deterministically invalid payloads are parked and kept.
Known gaps in the current application are outbox retention and exported backlog
metrics.

The internal AgentRun acceptance boundary follows that existing path: one
PostgreSQL transaction creates a `QUEUED` `agent_run` and an
`agent-run.queued` outbox event whose payload is only `{ runId }` and whose
dedupe key is that run id. The existing route publishes `execute` to
`agent-execution`. `WorkerModule` explicitly registers the single
`AgentExecutionHandler`; `QueueModule` contains publication only, so the API
composition root cannot consume jobs.

The handler stores BullMQ's `attemptsStarted` active-start ordinal as the durable
AgentRun `attemptCount` compare-and-set version. Unlike `attemptsMade`, that
ordinal advances for stalled-job recovery as well as ordinary retries. Terminal
and already-claimed deliveries are no-ops. Retryable failures stay `RUNNING` and
reject for BullMQ retry; the configured final attempt records `FAILED` and also
rejects so BullMQ job state remains truthful. Outbox delivery, BullMQ job, and
AgentRun lifecycle states remain distinct.

A process can call a model and die before recording `SUCCEEDED`; the later
attempt may call the model again. This is accepted for the current
model-only/read-only slice, not presented as exactly-once execution. Durable
tool-side-effect idempotency must be revisited before adding tools. There is
still no public AgentRun endpoint or production agent definition; the first
real agent feature will supply the authorized caller, definition, and provider
configuration.

If a job exceeds BullMQ's stalled-job allowance, BullMQ can fail it before the
handler runs again; the AgentRun can then remain `RUNNING`. Terminal transport
reconciliation is intentionally deferred while production definitions are
empty and must be resolved before enabling a real agent.
