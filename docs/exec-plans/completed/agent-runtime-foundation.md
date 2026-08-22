# Agent runtime foundation execution plan

## Goal

Deliver two stacked draft pull requests that add a durable, application-owned
`AgentRun` foundation and a background Mastra runtime adapter using the existing
PostgreSQL outbox and BullMQ worker architecture.

## Context

The backend already commits asynchronous work through `outbox_event`, routes
`agent-run.queued` to the `agent-execution` queue, and consumes registered queue
handlers only from the worker composition root. No production agent definition
or public AgentRun endpoint exists yet. PostgreSQL remains durable business
truth; BullMQ remains at-least-once execution transport.

## Scope

- PR 1 (`feat/agent-run-foundation`, base `main`): Prisma model and migration,
  application-owned persistence types, internal AgentRun creation service,
  atomic outbox acceptance, focused tests, and owning documentation.
- PR 2 (`feat/agent-runtime-mastra`, base `feat/agent-run-foundation`): minimal
  runtime/definition contracts, explicit runtime selection, Mastra adapter,
  AgentRunner, duplicate-safe queue handler, explicit worker registration,
  focused tests, dependency update, and owning documentation.
- Draft PR creation, final-head CI inspection, and bounded remediation.

## Non-goals

No public AgentRun endpoint, production agent definition, streaming, SSE,
cancellation, resume, checkpoints, memory, storage, RAG, tools, tool-execution
ledger, provider abstraction, workflow engine, plugin discovery, LangGraph
adapter, execution lease framework, sandbox, tracing platform, eval platform,
MCP, or deployment work.

## Constraints

- Reuse the existing outbox dispatcher, route, queue producer, queue worker,
  retry/retention policy, and API/worker composition split.
- Keep Mastra imports within `apps/backend/src/agents/runtime/mastra/**` and its
  tests; application/domain contracts cannot expose Mastra types.
- Persist runtime as a string and keep the business status lifecycle to
  `QUEUED`, `RUNNING`, `SUCCEEDED`, and `FAILED`.
- Enforce request idempotency durably with PostgreSQL uniqueness scoped to the
  organization; BullMQ `jobId` is only secondary deduplication.
- Model duplicate delivery honestly: terminal runs are no-ops, state claims are
  conditional, and a model call can repeat if a worker dies before success is
  recorded.
- Do not add provider secrets or make live provider calls.
- Do not merge, enable auto-merge, push to `main`, force-push, deploy, operate
  Staging/Production, or access runtime/GitHub Environment secrets.

## Acceptance criteria

### PR 1

- AgentRun and `agent-run.queued` outbox rows commit atomically and roll back
  together.
- Same organization/idempotency key returns one logical run; different
  organizations may reuse a key.
- The event payload contains only the run identifier and uses the run id as
  `dedupeKey`; the existing route resolves to `agent-execution` / `execute`.
- The migration applies and the committed Prisma client matches the schema.

### PR 2

- AgentRunner resolves the selected definition/runtime and returns only
  application-owned result types.
- The explicit registry resolves Mastra and fails loudly for unsupported names.
- Duplicate terminal delivery does no work; queued execution is claimed with a
  conditional database transition.
- Success persists output and completion; retryable failure rethrows without
  falsely finalizing; the final BullMQ attempt records `FAILED` then rethrows.
- Worker composition registers exactly the existing `agent-execution` /
  `execute` handler, while the API remains incapable of queue consumption.
- Mastra is mocked in adapter tests and no provider request occurs.

## Validation

Iterate with focused backend unit/E2E tests, then before each PR handoff run as
applicable:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend prisma:validate
pnpm --filter backend test:e2e
pnpm build
ops/tests/documentation.sh
git diff --check
```

CI must be green for each final head, or a concrete external blocker must be
recorded with the exact failed check and evidence.

## Required evidence

- Reviewed per-PR diffs and exact commit SHAs.
- Migration validation/application, focused test output, aggregate local checks,
  and final-head GitHub Actions results.
- Code-review and security/concurrency/idempotency findings with remediations.
- Draft PR URLs, bases, heads, limitations, and explicit untouched-environment
  confirmations.

## Git / PR policy

- PR 1 head `feat/agent-run-foundation`, base `main`.
- PR 2 head `feat/agent-runtime-mastra`, base
  `feat/agent-run-foundation`.
- Stage/publish only explicit reviewed paths. Keep both PRs draft and open for
  human review. Never rewrite either branch or retarget the stack.

## Decision log

- 2026-08-22: Selected the repository feature-implementation workflow with an
  active execution plan because the task spans two dependent PRs, migration,
  worker composition, reviews, and CI repair loops.
- 2026-08-22: Official current Mastra research selected only `@mastra/core`,
  `Agent` from `@mastra/core/agent`, and non-streaming `agent.generate(...)`;
  installed-package typings will arbitrate published-version details.
- 2026-08-22: Local `.git` is read-only in the execution sandbox. Authorized
  branch/commit/PR mutations will use the connected GitHub repository API; no
  force updates will be used.
- 2026-08-22: `AgentRunService` will reuse `OutboxRepository.append` through a
  write-only outbox persistence module, keeping BullMQ providers absent from the
  API composition root.
- 2026-08-22: No AgentRun RBAC permission is added because this slice exposes no
  route. Authorization for a concrete operation belongs with the first real
  agent endpoint.
- 2026-08-22: Worker attempt claims store BullMQ's `attemptsStarted`
  active-start ordinal as the durable `attemptCount` CAS version. This handles
  ordinary retries, duplicates, and stalled redelivery without introducing the
  deferred execution-lease framework; `attemptsMade` remains the source for
  BullMQ final-attempt classification.
- 2026-08-22: The RUNNING claim predicate is monotonic
  (`attemptCount < attemptsStarted`), not exact-predecessor
  (`attemptCount == attemptsStarted - 1`). Verified against installed BullMQ
  6.1.2: `attemptsStarted` is incremented by `HINCRBY` in
  `prepareJobForProcessing.lua` at move-to-active, before any application code
  runs, and stalled recovery does not reset it. A worker killed between
  activation and its first PostgreSQL write therefore consumes an ordinal the
  database never observes, so the durable sequence is strictly increasing with
  gaps. The exact-predecessor form wedged such a run permanently; the monotonic
  form treats the ordinal as a fencing token, which is sound because BullMQ
  never reissues or decrements it. Completion/failure writes stay gated on the
  exact claimed `attemptCount`, so a superseded worker cannot finalize.
- 2026-08-22: `AgentRun.agentVersion` is a plain integer application revision
  persisted at acceptance. Asynchronous work outlives the deployment that
  accepted it, so `agentId` alone cannot identify the code a worker should run.
  A simple pinned integer buys determinism without a versioning platform,
  database-managed definitions, or a lifecycle service.
- 2026-08-22: `AgentRun.createdByUserId` becomes nullable. Scheduled and
  system-initiated work has no authenticated application User, and null states
  exactly that. The rejected alternatives — an actor abstraction, a polymorphic
  initiator, a trigger hierarchy, or a synthetic system user — all add a domain
  concept this slice does not have.
- 2026-08-22: Both corrections edit the existing unmerged AgentRun migration
  rather than stacking corrective migrations. The migration has not landed on
  `main`, so there is no deployed state to preserve and no reason to publish
  historical churn.
- 2026-08-22: Correcting an earlier claim in this log: `prisma migrate dev`
  reporting the schema in sync proves the migration matches the schema, but it
  is not proof for the deployment path. Verified in Prisma 7.9.1 that a
  database which already applied the pre-remediation file reports "Database
  schema is up to date" and `migrate deploy` re-applies nothing, despite a
  changed checksum — there is no drift signal. CI is unaffected (a fresh
  Postgres service container each run) and Staging is unaffected (this
  migration has never been applied there), but any local database that applied
  commit `fc2ddac` keeps the old table and must be reset. This is the accepted
  cost of editing in place instead of publishing corrective migration churn.
- 2026-08-22: `AgentDefinition` carries an explicit `version` and the registry
  is keyed by the exact `(id, version)` pair. A duplicate pair is a composition
  error, distinct versions of one id are valid, and resolution never falls back
  to a latest version — silent drift onto newer code for a run accepted against
  an older definition is precisely what the pairing prevents. Definitions are
  immutable once published under a version; a version still referenced by a
  QUEUED or RUNNING AgentRun must remain resolvable across a rolling
  deployment. Automated retention of superseded versions is deliberately not
  implemented.
- 2026-08-22: Terminal BullMQ failure reconciliation remains deferred. Verified
  in BullMQ 6.1.2 that exceeding `maxStalledCount` (default 1) sets a deferred
  failure and fails the job on next pickup without invoking the processor, so
  no application code gets a chance to reconcile and the AgentRun can stay
  RUNNING. Building a transport reconciliation framework is out of scope for
  infrastructure PRs with empty production definitions, but it is recorded as a
  hard prerequisite before the first production AgentDefinition or public
  AgentRun API.
- 2026-08-22: Review remediation. `MastraRuntime` injects a discarding logger
  via `__setLogger` because `MastraBase` installs a `ConsoleLogger` by default
  and the execution loop logs the raw provider error — request body, response
  body, endpoint, model — through `console.error`, which bypasses the
  application's Pino redaction entirely. Latent today (production definitions
  are empty) but a real leak the moment a definition exists.
- 2026-08-22: The handler logs a fixed reason code (`runtime_error`,
  `claim_lost`) with the run id and attempt ordinals. Everything persisted and
  rethrown is one constant, so without this an operator cannot distinguish a
  missing definition from a provider timeout. The code is chosen at the throw
  site and never read from the error object.
- 2026-08-22: A lost claim no longer writes a durable failure. The write was a
  guaranteed CAS no-op, and skipping it states the ownership rule directly:
  the superseding delivery owns the outcome.
- 2026-08-22: Deferred with the terminal-reconciliation work rather than fixed
  here — resetting `attemptCount` when a reconciler writes `QUEUED` (the
  monotonic fence otherwise rejects the replayed job and it completes green),
  and classifying unresolvable definitions as `UnrecoverableError` (which must
  be coupled with forcing a final durable failure, or the job stops retrying
  while the run stays RUNNING).
- 2026-08-22: Prisma 7.9.1 deterministically emits trailing indentation in new
  enum field-reference blank lines. A path-scoped `.gitattributes` rule disables
  only `blank-at-eol` checking for generated Prisma output so committed bytes
  remain generator-current while handwritten files retain normal checks.
- 2026-08-22: Installed current `@mastra/core` 1.61.0 only. Production
  definitions remain empty, and no provider configuration is required.
- 2026-08-22: Worker consumption moved out of `QueueModule` and is composed in
  `WorkerModule` with an explicit `QUEUE_JOB_HANDLERS` factory. This follows Nest
  provider scope rules while preserving the existing queue runner and keeping
  the API unable to consume jobs.
- 2026-08-22: Runtime failures are converted to a constant diagnostic before
  both PostgreSQL persistence and BullMQ rejection, preventing provider
  messages, error names, or response bodies from entering durable/coordination
  state.
- 2026-08-22: Independent review found that `attemptsMade` does not advance for
  BullMQ stalled recovery. Claims now use `attemptsStarted`, with regression
  coverage for stalls before and after the first durable claim.

## Progress

- [x] Intake, repository policy, harness, workflow, role, and owning-doc review.
- [x] Evidence-backed source map and final design.
- [x] PR 1 published as draft #27; PR 2 published as draft #28 on top of it.
- [x] Remediation: `agentVersion` pinning, nullable `createdByUserId`,
  monotonic skipped-ordinal CAS, exact `(id, version)` definition resolution,
  and the owning documentation updates. The updated base was merged forward
  into PR 2 without rewriting either branch.
- [x] Final-head CI green for both remediated draft heads.
- [x] Final handoff report delivered.
- [x] Human review completed (PR 1 first, then PR 2) and both merged.

## Blockers

None. No blocker remains that belongs to this slice.

## Outcome

Both pull requests were reviewed by a human and merged to `main`.

| Item | Value |
|---|---|
| PR 1 | #27 `feat/agent-run-foundation` -> `main` |
| PR 1 merge commit | `ca26258c0e0199f9544a5fdcddf1ad87f3a94035` |
| PR 2 | #28 `feat/agent-runtime-mastra` -> `feat/agent-run-foundation` |
| PR 2 merge commit (final `main`) | `f313f4bf97ba0b71fdfdd4eea98eaee84c6b62dc` |
| Final-head CI | Green for both final heads before merge |
| Feature branches | Deleted after merge |

Every acceptance criterion above was met. What landed:

- Durable `AgentRun` accepted atomically with its `agent-run.queued` outbox
  event, idempotent per `(organizationId, idempotencyKey)`.
- `agentVersion` pinned at acceptance and resolved as an exact
  `(id, version)` pair, with no latest-version fallback.
- `attemptsStarted` used as a monotonic execution fencing token, with
  completion and failure writes gated on the exact claimed ordinal.
- A replaceable `AgentRuntime` boundary with Mastra confined to
  `apps/backend/src/agents/runtime/mastra/**`, provider logging contained, and
  production definitions deliberately empty.

### Deferred out of this slice

These were recorded here as known gaps and are not defects of the merged work.
They are carried by the follow-on plan
[agent-run-terminal-reconciliation](../active/agent-run-terminal-reconciliation.md):

- Terminal BullMQ failure reconciliation, recorded above as a hard prerequisite
  before the first production `AgentDefinition` or public AgentRun API.
- Classifying deterministic configuration failures as non-retryable, coupled
  with forcing a final durable failure.
- Narrowing the `Agent.__setLogger` SDK-compatibility risk.

The historical decision log above is preserved as written; it records what was
known at the time, including the entries that these follow-on items supersede.
