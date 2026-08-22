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
- 2026-08-22: Worker attempt claims will compare durable `attemptCount` with
  BullMQ's prior `attemptsMade` value, then use the incremented count as a CAS
  version for completion/failure writes. This addresses normal duplicate and
  retry races without introducing the deferred execution-lease framework.
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
- 2026-08-22: Prisma 7.9.1 deterministically emits trailing indentation in new
  enum field-reference blank lines. A path-scoped `.gitattributes` rule disables
  only `blank-at-eol` checking for generated Prisma output so committed bytes
  remain generator-current while handwritten files retain normal checks.

## Progress

- [x] Intake, repository policy, harness, workflow, role, and owning-doc review.
- [x] Evidence-backed source map and final design.
- [ ] PR 1 publication and final-head CI. Implementation, focused/aggregate
  validation, code review, and security review are complete.
- [ ] PR 2 implementation, focused validation, aggregate validation, review,
  publication, and final-head CI.
- [ ] Final documentation consistency review and handoff report.

## Blockers

None currently.
