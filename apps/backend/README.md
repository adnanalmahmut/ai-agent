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

## Where the code lives

`src/core` is the one place for shared backend platform and cross-cutting
runtime concerns. There is deliberately no second technical layer beside it:

```
src/core/
  auth/       authentication and authorization
  docs/       the OpenAPI document and its reference UI
  errors/     the application exception and its codes
  health/     liveness and readiness probes
  http/       the HTTP boundary: pipes, filters, response envelope
  i18n/       translation loading and locale resolution
  lifecycle/  process readiness and the shutdown helper
  mail/       rendering and delivery
  outbox/     the PostgreSQL → BullMQ handoff
  providers/  logger options, request id
  queue/      BullMQ transport: producer, worker runner, options
  redis/      connection provisioning per role
```

`src/database` holds the Prisma client; `src/config` holds the validated
environment. Feature modules live outside `core`.

Each folder is flat: implementation files sit directly in it, `index.ts` is its
public surface, and every `*.spec.ts` lives in a `__tests__/` subfolder beside
them. A module is read by scanning its folder, so nothing that is not
production code is allowed to appear in that scan. Whole-application tests are
not part of a module and live in `test/e2e/`, with their shared harness in
`test/support/`.

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

### A claim is versioned, so a stale dispatcher cannot overwrite a newer outcome

`(claimedBy, attempts)` identifies one claim of one row — `attempts` increments
atomically inside the claim statement, so a reclaim after a lapsed lease always
produces a different pair. `reschedule` and `markFailed` match on it and return
whether they changed anything; zero rows means "somebody else owns this now",
which is a normal outcome and not an error.

Without it: A claims, stalls, its lease expires, B reclaims and delivers — and
then A's late failure drags the delivered row back to `PENDING`, or down to
`FAILED`. Both silently.

`markDelivered` is deliberately exempt. A successful publish is a fact about
Redis rather than a judgement, and refusing it would leave a genuinely delivered
row `PROCESSING` and schedule a pointless re-delivery.

### Transport outages are retried forever; only impossible publishes are parked

| Failure | Example | Outcome |
|---|---|---|
| transient | `ECONNREFUSED`, `Command timed out`, `OOM`, `LOADING`, anything unrecognised | retried indefinitely, capped exponential backoff |
| permanent | circular JSON, `BigInt`, job over `sizeLimit` | parked as `FAILED` |

Unknown means transient, on purpose. The two mistakes are not equally
expensive: calling poison data transient costs one retry per backoff interval
and leaves a visibly stuck row, while calling an outage permanent destroys work
the API already told a caller it had accepted.

This is also why there is no terminal attempt budget.
`OUTBOX_WARN_AFTER_ATTEMPTS` only decides when the retries start being logged
loudly.

### Not built yet

Two gaps are known and deliberately outside this foundation, because neither is
a delivery guarantee and nothing here depends on them for correctness:

- **Retention.** `outbox_event` grows without bound. `DELIVERED` rows are never
  pruned, and `FAILED` rows are kept on purpose — a parked row is the only
  record that accepted work went unperformed. A bounded, batched, age-based
  prune belongs here, keeping `FAILED` far longer than `DELIVERED`.
- **Backlog metrics.** The two numbers that actually indicate outbox health —
  how many rows are claimable, and how old the oldest one is — are not exported.
  The dispatcher already computes per-pass counters and escalates its log level
  past `OUTBOX_WARN_AFTER_ATTEMPTS`; what is missing is somewhere to send them.

### A worker never claims an event type it cannot route

`ROUTABLE_EVENT_TYPES` — derived from `OUTBOX_EVENT_ROUTES`, not restated — goes
into the `WHERE type IN (...)` of every claim, for pending rows *and* for
expired leases. During a rollout the new API writes types the old worker has
never heard of; a worker that claimed one could only park it, destroying the
work before the new worker started.

## Shutdown

Both processes drain on `SIGTERM`, in orders that are their own:

**API** — fail readiness → wait for the load balancer
(`APP_SHUTDOWN_READINESS_DELAY_MS`) → close the listener, drain in-flight
requests, disconnect Redis and Prisma.

**Worker** — stop the outbox dispatcher → mark not ready → stop claiming jobs
and drain the active ones → close `QueueEvents` → close the producer →
disconnect Redis and Prisma. The step list lives in `src/worker.shutdown.ts`, so
the test can exercise the real sequence rather than a copy of it.

There is **one** deadline, `APP_SHUTDOWN_TIMEOUT_MS`, and every bounded wait
inside it derives from what is left:

```
allowed = min(componentMaximum, remaining − reserve)
```

`QUEUE_SHUTDOWN_GRACE_MS` is a *ceiling* on each drain, not an entitlement to
it. Giving each component its own full grace promises more time than the process
has — a 25 s dispatcher grace plus a 25 s worker drain inside a 30 s deadline
cannot both be honoured — and the discovery comes as a `SIGKILL` part-way
through closing a connection. A reserve is withheld from the draining steps so
closing the producer, Redis and Prisma always has some deadline left.

It must stay below the orchestrator's own termination grace period: a process
that gives up first exits having released what it could, one that overruns is
`SIGKILL`ed mid-write.

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

The e2e suites run against real Redis and PostgreSQL with per-run key
namespaces, because the behaviour they assert is precisely what a mock would not
reproduce:

- `test/e2e/outbox.e2e-spec.ts` — `FOR UPDATE SKIP LOCKED`, database-clock leases,
  conditional claim-version updates, and a crash window that performs a real
  `queue.add` before losing the acknowledgement.
- `test/e2e/queue-drain.e2e-spec.ts` — BullMQ's fetch loop and lock handling.
- `test/e2e/worker-shutdown.e2e-spec.ts` — the global deadline with a real active
  BullMQ job *and* a stuck outbox publication at the same time. The only
  injected part is the producer, since a real Redis cannot be made to hang on
  demand.

The e2e config pins `maxWorkers: 1`, and that is a correctness setting rather
than a performance one. Every suite shares one PostgreSQL database and one
Redis, and Redis is only survivable because each suite writes its own key
namespace. PostgreSQL has no equivalent: `outbox_event` is one table, the
dispatcher claims by event *type*, and a routable type is the same string in
every suite. Two suites running concurrently therefore claim each other's rows
and delete each other's fixtures — as a parallel run does, intermittently and in
whichever suite happens to lose. Serially the whole e2e run costs about a
second more, so there is nothing to trade away here.

CI runs all of it against service containers; see `.github/workflows/ci.yml`.
