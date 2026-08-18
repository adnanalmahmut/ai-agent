# Backend

NestJS API and background worker for the agents platform.

## Running it

```bash
# PostgreSQL and Redis
pnpm db:up

# Apply migrations
pnpm db:migrate

# The API process (HTTP)
pnpm dev

# The worker process (queue + outbox dispatcher), in a second terminal
pnpm worker:dev
```

The test stack runs on its own ports so a test run can never reach into
development data:

```bash
docker compose --profile test up -d   # PostgreSQL 5433, Redis 6378
```

Configuration is validated by Zod at boot — see `src/config/*.config.ts`, and
`.env.example` for every variable with the reasoning behind its default. A
missing or malformed value stops the process at startup rather than surfacing
as a runtime failure later.

## Two processes

| | `src/main.ts` (API) | `src/worker.ts` (Worker) |
|---|---|---|
| Serves | HTTP, on `APP_PORT` | nothing; no listener |
| Reads work from | requests | `outbox_event`, then BullMQ |
| PostgreSQL | yes | yes |
| Redis | health probe only | queue producer and consumer |
| BullMQ | **none** | producer, worker, events |

They have separate composition roots (`AppModule`, `WorkerModule`) rather than
one module behind a flag. What each process is *unable* to do is part of the
design: the API cannot inject a queue producer into a request handler, and the
worker carries no HTTP pipeline, auth guard or Swagger document it never serves.

Accepting asynchronous work is one PostgreSQL transaction — the business row and
an `outbox_event` together — after which the API returns. The request path holds
no queue connection, so a Redis outage cannot turn a valid request into a 5xx,
and no job can exist for a row that does not.

## Where state lives

**PostgreSQL is authoritative.** Agent runs, steps, tool executions and LLM call
records live only here. The system is designed so that losing the entire Redis
instance costs throughput and nothing else.

**Redis is coordination.** Stream buffers, partial state, rate-limit windows,
short-lived locks and BullMQ's own queue structures. Everything in it is either
reconstructible from PostgreSQL or cheap to lose.

Two rules follow from that split, and both are easier to break than to notice.

### Locks are a last resort

There is no `RedisLockService`, and adding one would be a mistake. A
general-purpose distributed lock invites locking as the default, and nearly
every invariant this system needs is better served by something that survives a
Redis restart:

- a PostgreSQL `UNIQUE` constraint,
- a conditional `UPDATE ... WHERE status = ...`,
- a BullMQ `jobId`,
- queue concurrency.

Introduce a lock only when a specific invariant demands one, and put it next to
that invariant rather than in a shared utility.

### Idempotency is durable in PostgreSQL

Redis and BullMQ can *collapse* duplicates quickly — BullMQ rejects a repeated
`jobId` while the job still exists in Redis — but that guarantee expires with
job retention. The durable guarantee is always a PostgreSQL constraint. Use the
fast path to avoid work, never to decide correctness.

## Delivery guarantees

Delivery is **at-least-once**, by construction rather than by accident.

```
POST → BEGIN; INSERT business row; INSERT outbox_event; COMMIT
                            ↓
OutboxDispatcher   claim a batch under a lease (FOR UPDATE SKIP LOCKED), commit
                            ↓
                   queue.add()
                            ↓
                   mark DELIVERED
```

A dispatcher that dies between the last two steps leaves the row `PROCESSING`;
its lease expires, another dispatcher reclaims it, and the job is published
again. **Every consumer must therefore be safe to run twice.** That is the price
of not needing a distributed transaction, and it is the cheaper side of the
trade.

## Shutdown

Both processes drain on `SIGTERM`, in orders that are their own:

**API** — fail readiness → wait for the load balancer
(`APP_SHUTDOWN_READINESS_DELAY_MS`) → close the listener, drain in-flight
requests, disconnect Redis and Prisma.

**Worker** — stop the outbox dispatcher → mark not ready → stop claiming jobs
and drain the active ones (`QUEUE_SHUTDOWN_GRACE_MS`) → close `QueueEvents` →
close the producer → disconnect Redis and Prisma.

The whole sequence is bounded by `APP_SHUTDOWN_TIMEOUT_MS`, which must stay
below the orchestrator's own termination grace period: a process that gives up
first exits having released what it could, one that overruns is `SIGKILL`ed
mid-write.

**A deployment is not a cancellation.** Nothing in either sequence writes
business state. A job abandoned when the grace period expires keeps its durable
record and is recovered by BullMQ's stalled-job handling. `CANCELLED` means
somebody decided the work should not happen, and a rolling restart is not that.

## Health probes

`GET /api/health/live` — is the process wedged? Touches nothing. A liveness
probe that consulted a dependency would turn one database outage into a restart
loop across every replica.

`GET /api/health/ready` — should traffic be sent here?

| Condition | Result |
|---|---|
| draining | `503`, `process.status = draining` |
| PostgreSQL down | `503`, `postgres.status = down` |
| Redis down | `200`, `redis.status = degraded`, `capabilities.queue = degraded` |

Redis is not critical for readiness because work is accepted into the outbox
without it. No external provider is ever called from a probe.

## Testing

```bash
pnpm test        # unit — no infrastructure required
pnpm test:e2e    # requires PostgreSQL and Redis
pnpm lint
pnpm typecheck
```

The e2e suites boot the real modules. `test/queue-drain.e2e-spec.ts` and
`test/outbox.e2e-spec.ts` run against real Redis and PostgreSQL with per-run key
namespaces — the behaviour they assert (`FOR UPDATE SKIP LOCKED`, BullMQ's fetch
loop and lock handling) is precisely what a mock would not reproduce.

CI runs all of it against service containers; see `.github/workflows/ci.yml`.
