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

There is a third entrypoint, `src/cli.ts`, which runs one operator command and
exits rather than serving anything. It creates the platform's first super
administrator — the one action nothing inside the authorized surface can
perform, because granting that role is itself a super-administrator action:

```bash
# `cli` runs dist/, so build first; `cli:dev` compiles on the fly instead.
pnpm --filter backend cli:dev super-admin:create \
  --email you@example.com --name 'Your Name'
```

It succeeds only while the platform has no super administrator. The password is
prompted for without echo, or read from the first line of stdin when the command
is not attached to a terminal; `--password` is rejected because it would be in
shell history before the command ever saw it. Exit codes and the operator
procedure are in [`docs/operations-runbook.md`](../../docs/operations-runbook.md).

The same entrypoint carries `managed-secret:rotate-key`, which re-encrypts
stored credentials under the active encryption key version after
`APP_ENCRYPTION_KEY` has been replaced:

```bash
pnpm --filter backend cli:dev managed-secret:rotate-key --dry-run
```

It changes no credential's value, skips rows that are already current, and is
safe to re-run or to resume after an interruption. `--dry-run` reports what
would change and writes nothing, which is also how you confirm nothing still
depends on an old key before retiring it. Its own composition root loads the
encryption keyring and no authentication stack, so this command cannot create or
elevate an account. The rollout phases and exit codes are in the same runbook.

The test stack runs on its own ports so a test run can never reach into
development data:

```bash
docker compose -f ../../docker-compose.yml --profile test up -d postgres-test redis-test
# PostgreSQL 5433, Redis 6378; both bind to loopback only.
```

Configuration is validated by Zod at boot — see
`src/infrastructure/config/*.config.ts`, and
`.env.example` for every variable with the reasoning behind its default. A
missing or malformed value stops the process at startup rather than surfacing
as a runtime failure later.

## Two processes

| | `src/main.ts` (API) | `src/workers/main.ts` (Worker) |
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

`src/infrastructure` owns technical adapters and cross-cutting runtime concerns:

```
src/infrastructure/
  auth/       authentication and authorization
  config/     validated runtime configuration
  database/   the Prisma client
  docs/       the OpenAPI document and its reference UI
  geoip/      fail-open local MMDB session enrichment
  health/     liveness and readiness probes
  http/       the HTTP boundary: pipes, filters, response envelope
  i18n/       translation loading and locale resolution
  lifecycle/  process readiness and the shutdown helper
  mail/       rendering and delivery
  outbox/     the PostgreSQL → BullMQ handoff
  providers/  logger options, request id
  queue/      BullMQ transport: producer, worker runner, options
  rate-limit/ atomic Redis sliding-window policy and decorators
  redis/      connection provisioning per role
```

`src/core` is deliberately small; it currently contains only the generic
application exception and its stable codes. Feature modules live outside both
technical layers.

Each folder is flat: implementation files sit directly in it, `index.ts` is its
public surface, and every `*.spec.ts` lives in a `__tests__/` subfolder beside
them. A module is read by scanning its folder, so nothing that is not
production code is allowed to appear in that scan. Whole-application tests are
not part of a module and live in `test/e2e/`, with their shared harness in
`test/support/`.

## Where state lives

**PostgreSQL is authoritative.** Accepted AgentRuns and their lifecycle live
only here. Agent steps, tool-execution ledgers and separate LLM-call records do
not exist yet; they must not be inferred from the AgentRun foundation. The
system is designed so that losing the entire Redis instance costs throughput
and nothing else.

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

### Background agent execution

The worker composes one explicit `agent-execution` / `execute` handler. It loads
the durable AgentRun by `{ runId }`, conditionally claims the BullMQ attempt,
resolves the code-owned definition the run was pinned to, reloads the exact
immutable organization-agent configuration selected at acceptance, and passes
application-owned input and parsed configuration through `AgentRunner` to an
explicit runtime registry. The queue payload remains only `{ runId }`;
PostgreSQL is the version and configuration authority.

The runtime contract intentionally has only `name` and `run`. Mastra is the
first adapter, and every Mastra import must stay within
`src/ai/infrastructure/runtimes/mastra/**` or the tests that exercise that
adapter.

The adapter installs the SDK's exported `noopLogger` on each agent before
running it. `MastraBase` otherwise constructs a `ConsoleLogger` at level
`error`, and the agent loop logs the raw provider error — the outbound request
body containing the instructions and the prompt, the provider response body,
the endpoint and the model id — through `console.error`, where Pino's redaction
never sees it. No environment variable disables it. `noopLogger` is the same
object Mastra installs for its documented `logger: false`, and it is assigned
through a typed local so a future SDK that changes the hook fails `typecheck`
rather than silently regressing into unredacted logging. A no-network adapter
test drives the real SDK with a stub model and asserts nothing reaches
`console.*`, alongside an inverted control that proves the leak is real.

Two residual limits are worth stating: `__setLogger` is typed and not marked
internal, but it is undocumented; and the SDK contains raw `console.*` calls
that no logger injection can reach. Neither is on a path this adapter exercises
today, which is why the test asserts on `console.*` rather than on the logger. Application types,
durable state, retry decisions, and definition ownership remain outside the SDK
boundary. A future real agent is registered by adding its minimal definition to
`src/features/content/ideas/agent-definitions/index.ts`, then adding the authorized API and provider
configuration in that feature. The first one starts at version 1.

Definitions are identified by the exact `(id, version)` pair, and a definition
is immutable once published under a version. `AgentRunner` resolves the pair
persisted on the run, never the id alone, so a run accepted before a deployment
still executes the revision it was accepted against. New runs also carry a
tenant-bound immutable organization-agent version id. Every worker attempt
reloads it from PostgreSQL and validates tenant, agent, definition revision,
and configuration before reaching the runtime; legacy null-reference runs use
the pinned definition's owned default. A duplicate `(id, version)` is a
composition error, distinct versions of one id are valid, and an unknown pair
fails loudly — there is deliberately no fallback to a latest version. Any
version still referenced by a `QUEUED` or `RUNNING` AgentRun must therefore
remain resolvable throughout a rolling deployment. Automated retention of
superseded versions is not implemented.

Attempt claims use `(status, attemptCount)` as a PostgreSQL compare-and-set
version. `attemptCount` records BullMQ's active-start ordinal, which advances
for ordinary retries and stalled-job recovery.

The claim is monotonic: a delivery takes ownership when
`attemptCount < attemptsStarted`. It is deliberately not an exact predecessor.
BullMQ increments `attemptsStarted` in Redis at move-to-active, before this
process runs, so a worker killed before its first write consumes an ordinal
PostgreSQL never observes and the durable sequence can skip values. Demanding
`attemptsStarted - 1` wedged exactly those runs. The ordinal works as a fencing
token because BullMQ never reissues or decrements it, and completion and
failure writes still CAS on the exact claimed `attemptCount`, so a superseded
worker cannot finalize a run a newer delivery now owns.

A stale, duplicate, or terminal delivery is a no-op; an intermediate failure
remains `RUNNING` and is rethrown for BullMQ retry; the configured final attempt
records `FAILED` and still rejects the job. Persisted and BullMQ failure messages are generic
diagnostics and do not include provider messages, error names, responses, or
stacks.

This does not make model execution exactly once. A worker can receive a model
response and die before recording `SUCCEEDED`, so a later BullMQ attempt can
call the model again. That limitation is accepted only for the current
model-only/read-only slice. Before an agent gains tools with external side
effects, durable ToolExecution/idempotency semantics must be designed from that
real tool use case. Streaming, memory, storage, workflows, cancellation,
checkpoints, provider abstraction, and tool abstraction are intentionally
deferred.

### The transport can end a job without the handler

BullMQ fails a job before invoking the handler when it exceeds its stalled-job
allowance (`maxStalledCount`, default 1): the stalled check writes a deferred
failure marker and returns the job to `wait`, and the next fetch turns that
marker into a synthetic `UnrecoverableError` on a branch that skips the
processor. No application code runs, so nothing records the outcome.

`AgentRunReconciler` — worker-only, on its own interval — reads a bounded page
of the oldest non-terminal runs from PostgreSQL, asks the transport for each
one's job state, and writes `FAILED` with `completedAt` and a safe constant for
the ones whose job is in the failed set. The write is conditional on the run
still being `QUEUED` or `RUNNING`, so it is idempotent and cannot overwrite a
terminal outcome; it does not match on `attemptCount`, because the sweep is not
an attempt.

It reads through a keyset cursor on `(updatedAt, id)`, which is what makes the
sweep progress rather than merely repeat. A candidate it cannot act on is left
unwritten, so `updatedAt` never moves and always-from-the-beginning would return
the same rows forever — and once enough of them filled a page, no newer run
would be examined again. The cursor resets on a short page, so the scan cycles;
losing it to a restart costs a cycle, not correctness.

The cursor moves only past a finished observation: for `pending` and `missing`
that is the transport verdict, and for `failed` it is the terminal write
resolving. A rejected write leaves the cursor behind the candidate, so the next
pass retries the same row instead of scanning past a run it has already proven
needs finalizing.

What the conditional does *not* protect is a run still in flight. A worker whose
lock lapsed mid-model-call keeps running, and if the sweep finalizes the run
first, that worker's success write matches nothing and its result is discarded.
An accepted trade — the transport has given up, and `RUNNING` forever is worse —
and a reason to keep the staleness threshold above the slowest expected call.

`QueueEvents` would have been the smaller-looking answer and is not a correct
one: it reads the stream from `$` with no persisted cursor, so an event
published while the process is down is lost rather than delayed. Correctness
lives in the sweep, which keeps nothing between passes.

It never re-queues and never fails a run for being slow. Re-running a failed run
would restart `attemptsStarted` at 1 against a higher `attemptCount` and be
rejected by the fence, so it belongs to a separate future operation; and a job
the transport has no record of is logged, not failed, because retention and
not-yet-published look identical from here.

### A deterministic failure is final immediately

An unregistered `(agentId, agentVersion)` pair, a runtime that disagrees with
its definition, and an unsupported runtime raise `AgentConfigurationError`. The
registries come from code, so a retry resolves the same thing; the handler
records the durable failure as final and throws `UnrecoverableError`.

Only when it still holds the claim, though. If the finalizing write matched
nothing, a newer delivery owns the run, and terminally failing the job on its
behalf would end work that is still running — so a stale delivery rejects
ordinarily. Classification is `instanceof` and nothing else, so a provider error
cannot choose a name or message that talks the worker out of its retries.

This makes deployment order matter when a definition is added: bring the worker
up before, or with, the API, or a run accepted by a new API instance and
delivered to an older worker is failed immediately rather than retried.

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
disconnect Redis and Prisma. The step list lives in `src/workers/worker.shutdown.ts`, so
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
