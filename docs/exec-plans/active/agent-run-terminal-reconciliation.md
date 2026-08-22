# Agent run terminal reconciliation execution plan

## Goal

Close the remaining reliability gaps in the generic AgentRun infrastructure so
that no known hard blocker prevents starting the first real production agent
vertical slice.

Concretely: a terminal BullMQ failure for `agent-execution` must never leave its
`agent_run` row non-terminal forever, deterministic configuration failures must
stop consuming retry budget, and the Mastra logger containment must rest on the
strongest evidence reasonably available.

## Context

The foundation landed in
[agent-runtime-foundation](../completed/agent-runtime-foundation.md) (PR #27
merge `ca26258c0e0199f9544a5fdcddf1ad87f3a94035`, PR #28 merge
`f313f4bf97ba0b71fdfdd4eea98eaee84c6b62dc`). It left three items recorded as
known gaps rather than defects:

1. **Terminal transport reconciliation.** BullMQ can fail a job terminally
   without invoking the processor — the stalled-allowance path. The application
   therefore never records `FAILED`, and the run stays `RUNNING` indefinitely.
   The merged documentation states this is a hard prerequisite before the first
   production `AgentDefinition` or public AgentRun API.
2. **Deterministic configuration failures.** An unregistered
   `(agentId, agentVersion)` pair, a persisted runtime that disagrees with the
   definition, or an unregistered runtime cannot succeed on retry, yet they burn
   the full retry budget with exponential backoff.
3. **`Agent.__setLogger`.** Provider log containment relies on a
   private-looking SDK hook, which is an upgrade-compatibility risk.

PostgreSQL remains business authority; Redis/BullMQ remains coordination and
at-least-once transport. Those roles do not change here.

## Scope

- A durable, idempotent terminal-failure reconciliation mechanism for
  `agent-execution`, composed only in the worker process.
- The narrowest queue/application boundary needed to keep `core/queue`
  independent of `agents`.
- An application-owned classification separating deterministic non-retryable
  execution failures from retryable runtime/provider failures.
- Mastra logger containment: adopt a supported public API if one exists in the
  installed version; otherwise narrow the risk with the strongest no-network
  compatibility evidence available.
- Focused concurrency and failure-path tests, including real Redis/PostgreSQL
  integration where BullMQ semantics are the thing under test.
- Owning documentation and both execution plans.

## Non-goals

No first production `AgentDefinition`, public `POST /agent-runs`, provider
credentials, live provider calls, tools, tool-execution ledger, memory,
conversation memory, RAG, embeddings, vector store, streaming, SSE,
cancellation, resume, checkpoints, workflow engine, multi-agent orchestration,
provider abstraction framework, runtime plugin discovery, LangGraph adapter,
MCP, sandbox, eval platform, tracing platform, generic queue reconciliation
framework, generic event bus, distributed execution lease framework, or
automatic AgentRun replay/requeue.

Automatic requeue is specifically excluded. A fresh BullMQ job restarts
`attemptsStarted` at 1 while the run may hold a higher `attemptCount`, so the
monotonic fence would reject the claim. Re-running a failed run is a distinct
future operation with its own semantics.

## Constraints

- PostgreSQL is business authority; BullMQ proves transport state only.
- `core/queue` must not depend on `agents`.
- The API composition root must remain structurally incapable of consuming
  jobs or running reconciliation.
- Preserve the existing fencing rule exactly: claim on
  `attemptCount < attemptsStarted`; completion and failure writes CAS on the
  exact claimed `attemptCount`.
- Reconciliation must be idempotent, terminal-safe, and must not depend on
  in-process memory or on an ephemeral notification for correctness.
- Never persist or log BullMQ/provider raw errors, stacks, causes, response
  bodies, prompts, or request payloads. Durable diagnostics are application-owned
  constants.
- Mastra imports stay within `apps/backend/src/agents/runtime/mastra/**` and its
  tests.
- Prefer no migration. Add one only with a stated reason that is not new durable
  state.
- No provider secrets and no live provider calls.
- One focused branch and one PR against `main`. No merge, auto-merge,
  force-push, history rewrite, deployment, or environment/secret operation.

## Acceptance criteria

### Terminal reconciliation

- A `RUNNING` run whose BullMQ job reached terminal failure becomes `FAILED`
  with `completedAt` set and a safe constant `lastError`.
- A `QUEUED` run in the same situation becomes `FAILED`.
- `SUCCEEDED` and `FAILED` runs are untouched.
- Repeated and reordered observations are no-ops.
- An unknown or missing run does not crash the worker.
- Correctness survives process restart and does not depend on having observed a
  notification.
- A transient PostgreSQL failure during reconciliation is retried by a later
  pass rather than lost.
- Enumeration/lookup against Redis is bounded, not an unbounded scan.

### Deterministic failures

- An unregistered `(agentId, agentVersion)` pair, a runtime mismatch, and an
  unregistered runtime are classified as deterministic and non-retryable.
- When the delivery still owns the claim: the run becomes `FAILED` with
  `completedAt` and a safe constant, a fixed operator reason code is emitted,
  and BullMQ receives `UnrecoverableError` carrying only a safe constant.
- When the finalizing CAS fails because a newer delivery owns the run: nothing
  is overwritten, and the stale delivery does not terminally fail the job on the
  newer owner's behalf.
- Transient runtime/provider failures keep the existing retry budget and
  behavior.

### Mastra containment

- Either a supported public API replaces `__setLogger`, or the existing
  containment is retained with recorded evidence and the strongest feasible
  no-network compatibility coverage against the real installed SDK.
- No provider request, provider package, or API key is required by any test.

### Invariants preserved

Existing idempotency, version pinning, skipped-ordinal claiming, terminal
guards, and lost-claim behavior all remain green.

## Validation

Focused checks while iterating, then the required aggregate set:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend prisma:validate
pnpm --filter backend prisma:generate
git diff --exit-code -- apps/backend/src/generated/prisma
pnpm --filter backend test:e2e
pnpm build
ops/tests/documentation.sh
git diff --check
```

E2E requires the test services (`pnpm db:up` equivalents for the `test`
profile). CI on the final head must be green.

## Required evidence

- Installed-source citations for every BullMQ and Mastra behavioral claim.
- Focused test output demonstrating each acceptance criterion, including a test
  that fails against the pre-change behavior.
- Aggregate local validation output and the final-head GitHub Actions result.
- Code-review, security-review, and test-engineer findings with remediations.
- PR URL, base, head, and explicit untouched-environment confirmations.

## Git / PR policy

- Branch `feat/agent-run-terminal-reconciliation`, base `main`.
- One focused PR, left open and unmerged for human review. Merging to `main`
  deploys live Staging and is a human decision.
- Stage explicit reviewed paths only. Never force-push or rewrite history.

## Decision log

- 2026-08-22: Opened this plan and moved
  [agent-runtime-foundation](../completed/agent-runtime-foundation.md) to
  `completed/` with its landing evidence. The previous plan had remained under
  `active/` after its work merged, which is exactly the false active state the
  execution-plan convention forbids.
- 2026-08-22: Corrected the failure model against installed BullMQ 6.1.2. The
  official documentation and the shipped `.d.ts` both say a job exceeding
  `maxStalledCount` "is moved to failed". Neither is accurate for this version:
  `moveStalledJobsToWait-9.lua` writes the reason into the `defa` hash field and
  calls `moveJobToWait`, and the job becomes `failed` only when a live worker
  fetches it again and `worker.js` converts `defa` into a synthetic
  `UnrecoverableError` on the branch that skips `callProcessJob`. Installed
  source wins over the documentation. Two consequences shaped the design: the
  processor really is never invoked, and the terminal transition additionally
  requires a running worker — with the fleet down, the job sits in `wait`
  indefinitely and never enters the failed set at all.
- 2026-08-22: `QueueEvents` was evaluated and rejected as the reconciliation
  mechanism, not merely deprioritized. Its consumer is a plain `XREAD` from `$`
  (`queue-events.js:70-82`) with no cursor persisted anywhere and no consumer
  groups in the package at all, so an event published while the process is down
  is lost rather than delivered late; the stream is trimmed to ~10k entries; and
  `emit` is synchronous, so an `async` listener that rejects becomes an
  unhandled rejection and takes the process down. A mechanism that loses its
  input across a restart cannot be what guarantees eventual consistency. It
  stays what it already was: failure telemetry.
- 2026-08-22: Reconciliation is driven from PostgreSQL, not from the Redis
  failed set. The alternative pages thousands of already-reconciled jobs each
  interval and asks the disposable store to enumerate the authoritative one's
  work. Driving from the non-terminal rows keeps the candidate set proportional
  to the problem, and each candidate costs one `getJobState` — a single Lua
  command on the non-blocking connection the producer already holds. The lookup
  needs no mapping table because acceptance uses the run id as the outbox dedupe
  key and the dispatcher passes it through as the BullMQ `jobId`.
- 2026-08-22: A near-real-time notification path was not added alongside the
  sweep. The task allowed the combination only on evidence that both are
  necessary; the evidence says the notification is neither sufficient nor
  needed, and no consumer exists yet for whom the reduced latency would matter.
  The cost of being wrong is bounded and visible: one sweep interval.
- 2026-08-22: The reconciler's write is conditional on `status IN (QUEUED,
  RUNNING)` and deliberately not on `attemptCount`. The attempt fence stops one
  delivery overwriting another's outcome, and this caller is not a delivery — it
  is the observation that deliveries have stopped. Gating it on an ordinal would
  mean guessing which abandoned attempt to impersonate, and the guess would be
  wrong precisely in the skipped-ordinal case the fence exists for. The status
  filter is what makes duplicate, delayed, and reordered observations no-ops and
  keeps a run a late worker completed from being dragged back to failed.
- 2026-08-22: A missing transport record is logged, never failed. Retention
  removing a week-old failed job and the outbox not having published yet are
  indistinguishable from here, and the alternative is a duration after which a
  live run is declared dead — a policy this slice has no evidence to set. The
  residual exposure is a run whose job was trimmed before any sweep saw it,
  which requires the reconciler to have been down for the whole retention window.
- 2026-08-22: `INDEX (status, updatedAt)` is the only schema change. It is not
  durable state and correctness does not depend on it, so it sits outside the
  "prefer no migration" rule on purpose: terminal rows are never deleted, so
  without it the bounded candidate query costs a scan proportional to total
  history rather than to the backlog. Measured on PostgreSQL 16 with 200,000
  terminal rows and a 200-row live tail, the candidate query plans as a bitmap
  index scan touching three heap blocks and runs in 0.5 ms; with the index
  removed the same query is a sequential scan at 58 ms. Two honest caveats: the
  planner reverts to a sequential scan when the non-terminal share is large
  (half the table in a deliberately pathological probe), which is a regime with
  worse problems than this query; and the `IN` over two statuses means a top-N
  sort remains, which a partial index would remove but Prisma cannot express.
  The staleness threshold is likewise a cost bound and not a timeout — every
  candidate is still checked against the transport before anything is written.
- 2026-08-22: Deterministic failures use one application-owned error class, not
  a taxonomy. Every case it covers is the same mismatch between a durable run
  and the deployed code, and all of them get the same treatment. Classification
  is `instanceof` and never the error's `name` or `message`: only this
  repository can construct the class, so a failing provider cannot choose fields
  that talk the worker out of its retries.
- 2026-08-22: `UnrecoverableError` is thrown only when the finalizing write
  matched. That write requires `status = RUNNING` and the exact claimed
  `attemptCount`, so a match proves this delivery still owned the run. From a
  stale delivery the same throw would terminally fail a job whose newer delivery
  is still executing. The pairing is the point: stopping the retries without
  forcing the durable failure final would trade a wasted budget for a stranded
  row, which is the failure mode the previous plan warned about.
- 2026-08-22: Automatic requeue stays unimplemented, so the previously recorded
  constraint about resetting `attemptCount` alongside a `QUEUED` write no longer
  applies to anything. Terminal transport failure now produces durable `FAILED`;
  re-running a failed run is a separate future operation that must define its own
  fencing semantics.
- 2026-08-22: Mastra logger containment keeps `__setLogger` but stops
  hand-rolling the logger. `AgentConfig` has no `logger` property in 1.61.0; the
  only documented alternative is `new Agent({ mastra: new Mastra({ logger: false
  }) })`, which reaches the same method internally while also constructing an
  in-memory store, an orchestration worker, a background-task manager and a
  notification workflow — infrastructure this adapter exists to avoid. Instead
  the adapter installs the SDK's exported `noopLogger`, which is the very object
  Mastra installs for `logger: false`, assigned through a typed local so the
  previous `as unknown` cast no longer hides a future interface change.
  `__setLogger` is typed and, unlike its `__`-prefixed siblings, carries no
  `@internal` tag, so an SDK that removes it fails `typecheck` loudly.
- 2026-08-22: The Mastra adapter gains a no-network real-SDK containment test
  with an inverted control. The previous spec mocked `@mastra/core/agent`
  wholesale and therefore asserted nothing about the SDK. The new one drives the
  real `Agent` with a stub `LanguageModelV2` that throws a provider-shaped error
  and asserts zero `console.*` calls and no canary strings; the control proves a
  bare agent does leak all three canaries through one `console.error`. Asserting
  on `console.*` rather than on the logger object also covers the raw
  `console.*` call sites in the SDK that no logger injection can reach.

## Progress

- [x] Intake: harness, policies, workflow, and the completed plan's deferred
  items reviewed.
- [x] Discovery: BullMQ 6.1.2 terminal-failure semantics and `QueueEvents`
  durability, Mastra 1.61.0 logger surface, and the existing dispatcher,
  lifecycle, configuration and integration-test infrastructure — all from
  installed source.
- [x] Design and implementation.
- [x] Focused tests, including a real-Redis reproduction of the stalled-allowance
  path in which the handler is provably not invoked.
- [ ] Aggregate validation.
- [ ] Code, security, and test reviews.
- [ ] PR opened with green final-head CI.

## Blockers

None currently.

## Known unrelated observation

`outbox.e2e-spec.ts › claim › honours the batch limit` fails intermittently,
returning all five rows for a claim whose `limit` is 2. Nothing in this change
touches `src/core/outbox`.

Evidence that it is pre-existing:

- Run alone and interleaved, it failed on a clean `main` worktree at `f313f4b`
  3 times in 5 and on this branch 2 times in 5, then both stopped together.
- Over the full suite, `main` failed 1 run in 7 and this branch 1 in 4; in the
  branch failure it appeared alongside the three already-known
  `better-auth-rate-limit` timing tests, which is the signature of machine load
  rather than of a code path.

Not root-caused, and deliberately not pursued here. One hypothesis worth a
separate investigation: a `LIMIT` bound as a parameter through Prisma
`$queryRaw` appears not to be applied, which under a prepared-statement or
pooled-connection explanation would be load-correlated and rare. If that is
real it is a general `$queryRaw` concern rather than an outbox one, and its
practical effect on the dispatcher is a larger-than-configured batch, not lost
or duplicated work.
