# Organization model policy and AgentRun pinning

## Goal

Deliver MOD-01B as the smallest durable policy slice on top of MOD-01A: let an
immutable code definition bound organization model choice, persist that choice
on immutable organization-agent versions, and pin the effective model, policy
revision, and price revision to every newly accepted AgentRun.

## Context

MOD-01A introduced exact application model identities and immutable,
effective-dated pricing revisions. Existing AGT-01/AGT-02 architecture already
provides the lifecycle seam MOD-01B needs: `OrganizationAgentVersion` is an
immutable organization-owned state record, run acceptance resolves its active
pointer inside the run/outbox transaction, and workers retry from PostgreSQL
using only the queued `runId`.

The production catalog currently has one generation model. This PR must not add
an unsupported second model to manufacture a picker. The organization boundary
will nonetheless be a real bounded choice: a definition declares a stable
policy revision and finite allowed-model maximum, while an organization version
selects exactly one member. Today that set is intentionally a singleton. Tests
use two definition/policy revisions over the same justified model to prove
historical policy pinning without pretending a second provider model exists.

## Scope

- Extend `AgentDefinition` with one stable model-policy revision identity and a
  finite allowed-model list; the existing model identity remains that policy's
  default choice.
- Validate every registered definition policy at composition: non-empty stable
  identity, non-empty unique allowed set, default membership, and catalog agent
  capability compatibility.
- Add a strict optional stable `modelId` choice to organization-agent create and
  replace requests. Unknown catalog identities and choices outside the exact
  definition maximum fail closed before persistence.
- Persist the resolved `modelPolicyId` and `modelId` on every new immutable
  `OrganizationAgentVersion` and expose them in the bounded management/history
  contracts. Nullable database columns preserve preceding-image writes.
- During the existing authoritative acceptance transaction, resolve the active
  version's definition and model policy, choose the exact price revision at the
  run acceptance instant, and persist `modelPolicyId`, `modelId`, and
  `modelPricingRevisionId` on `AgentRun` with the existing definition,
  organization-version, run, and outbox identities.
- Pass the run-pinned model identity through the application runtime request;
  Mastra resolves only that identity and never consults current organization
  state or silently substitutes another model.
- Revalidate pinned model/policy/price consistency against the pinned definition
  and code catalog on every execution attempt.
- Add additive migration, generated Prisma client, focused unit/E2E coverage,
  and narrow backend/database/queue documentation.

## Non-goals

- Adding a second production generation model without a current source path.
- Usage quantities, token accounting, cost arithmetic, aggregation, ledgers,
  billing, budgets, invoices, or USE-01.
- Provider/model failover, latest aliases, arbitrary provider registration, a
  generic policy engine, database-owned AgentDefinitions, or runtime-owned
  policy resolution.
- A Platform model picker. The current allowed set is a singleton and the
  existing authorized API is sufficient to prove the boundary.
- Changing queue payloads, retry counts, provider reproducibility claims,
  knowledge policy, prompts, credentials, or agent tools.

## Constraints

- PostgreSQL remains durable authority. Redis/BullMQ continues to carry only
  `runId`; no model or policy field enters a queue payload.
- Run policy is resolved after the in-transaction idempotency check and before
  the run/outbox commit. Retrying an accepted idempotency key returns the
  original pinned row even after the active organization policy changes.
- The acceptance instant used for price resolution is persisted as the run's
  exact `createdAt`, so the selected price revision can be recomputed and
  checked without relying on a later wall clock.
- Every new organization version and run writes complete non-null policy state
  by application invariant. Columns remain nullable only for expand/rollback
  compatibility and historical rows.
- A legacy organization version with both model fields null derives the pinned
  definition revision's code-owned default when accepting a new run; it never
  uses a current/latest definition. A partial legacy pair fails closed.
- A legacy run with all three policy fields null executes the pinned definition
  revision's default model, matching the only model behavior that existed when
  it was accepted. A partial triple fails closed and no legacy path consults an
  active installation pointer.
- Policy/model/price disagreement is a deterministic
  `AgentConfigurationError`, consumes no retry budget, and exposes no request,
  organization configuration, or provider material.
- The migration is additive. The preceding image ignores the new nullable
  columns and can continue writing nulls during rollback; contraction/backfill
  is deferred until rollback compatibility no longer requires them.
- Preserve inherited primary-worktree changes and keep `TODO.md` local only.
  Never force-push, merge, enable auto-merge, deploy, or operate Staging.

## Acceptance criteria

- A registered allowed catalog model is accepted and persisted on a new
  organization version; unknown and capability-incompatible identities are
  refused without a new version.
- An organization cannot select outside the exact allowed-model maximum declared
  by the pinned AgentDefinition revision.
- A new AgentRun atomically records the selected model, stable policy revision,
  applicable price revision, exact AgentDefinition revision,
  OrganizationAgentVersion, acceptance instant, and runId-only outbox event.
- A run accepted under policy A remains on A after the installation switches to
  policy B; an idempotent retry and repeated/requeued worker execution remain on
  A, while a newly accepted run pins B.
- The runtime receives the run-pinned stable application model identity, not the
  definition default, request payload, current organization pointer, provider
  alias, or a queue field.
- Missing, unknown, partial, or mismatched pinned identities fail closed with no
  model fallback and no provider call.
- Pricing identity remains explainable by exact stable revision and the run's
  persisted acceptance instant. No quantities or cost totals are introduced.
- Cross-tenant OrganizationAgentVersion protection and all existing
  authorization/idempotency/capacity/outbox/attempt-fencing invariants remain
  green.
- Legacy all-null organization versions and runs follow their explicit pinned
  definition-default compatibility rules; newly accepted runs never store null
  policy fields.
- Content-idea and installation request bodies cannot smuggle a provider alias
  or arbitrary model string; only the strict stable-ID field is considered.

## Validation

Focused iteration:

```sh
pnpm --filter backend test -- agent-definition-registry organization-agent-installation agent-runner mastra.runtime
pnpm --filter backend typecheck
pnpm --filter backend lint
```

Migration and persisted lifecycle:

```sh
cd apps/backend && pnpm exec prisma format
pnpm --filter backend prisma:validate
pnpm --filter backend prisma:generate
git diff --exit-code -- apps/backend/src/generated/prisma
pnpm --filter backend db:deploy
pnpm --filter backend test:e2e
```

Aggregate:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
ops/tests/documentation.sh
git diff --check
```

## Required evidence

- Policy A/B organization-version and run identities before/after pointer
  change; runtime calls showing repeated A and new B policy resolution.
- Run `createdAt` and exact price revision identity, plus refusal of unknown,
  disallowed, partial, and mismatched identities.
- Run/outbox transaction rollback and queue payload remaining `{ runId }`.
- Tenant isolation, request-smuggling, and legacy all-null compatibility results.
- Prisma format/validate/generate currentness, additive migration SQL,
  apply-from-zero/status evidence, and full backend E2E output.
- Independent code, test, and security review findings and remediation; final
  diff, commit, PR URL/base/head, and final-head GitHub CI.

## Git / PR policy

- Head `feat/model-policy-run-pinning`, exact base
  `feat/model-catalog-core` at
  `f73ae25b023dd62d0ee55e6dfb35075dc8a5ec53`.
- Stage only reviewed MOD-01B paths. Push normally and open one PR against the
  feature base; leave both PRs open for human review.
- SEC-01A remains an independent sibling from fresh `origin/main`; schema file
  overlap does not create a semantic dependency.

## Risks and rollback

- A worker could drift to the active organization pointer. Runtime selection is
  derived only from the claimed run's pinned columns and definition revision;
  tests switch policy before repeated execution and assert the original values.
- Nullable rollout columns could become an escape hatch. New write paths have
  no null branch and tests inspect persisted rows. Compatibility accepts only
  all-null legacy shapes and rejects partial state.
- A caller could try a valid catalog model outside one definition's maximum.
  Request syntax and definition-policy authorization are separate checks; the
  latter is repeated before organization version persistence and run execution.
- Pricing could be resolved from execution time. Acceptance writes one exact
  instant and revision inside the run/outbox transaction; workers validate that
  stable identity rather than resolving against their current time.
- The previous image remains rollback-compatible because every added column is
  nullable and it ignores them. New code explicitly understands nulls written
  by that image; old keys/rows are not backfilled or contracted in this PR.

## Decision log

- 2026-08-27: Existing immutable OrganizationAgentVersion and AgentRun lifecycle
  records are the policy store and snapshot boundary. No parallel policy table,
  dynamic policy engine, or queue schema is introduced.
- 2026-08-27: The current production allowed set remains the singleton
  `openai.gpt-4o-mini`. Policy A/B tests use two stable policy revisions over
  that same justified model instead of adding a fictional production model.
- 2026-08-27: Organization-version fields pin the choice that administrators
  made; AgentRun duplicates the three stable model-policy identities needed for
  self-contained execution and historical explanation, while retaining the
  immutable version reference that explains the organization decision.
- 2026-08-27: Prisma 7 current documentation confirms committed migrations are
  applied with `migrate deploy`, generated client currentness is checked after
  `prisma generate`, and every transactional query must use the callback's
  transaction client. The implementation follows the existing repository CI.

## Progress

- [x] Dependency/base, prior MOD/AGT architecture, lifecycle, schema, tests, and migration contract inspected.
- [x] Current Prisma 7 migration and transaction documentation checked through Context7.
- [x] Minimal design and compatibility rules selected and recorded.
- [x] Additive schema, generated client, registry policy, organization-version,
  run-acceptance, worker-validation, and Mastra pinned-model paths implemented.
- [x] Focused policy, request-boundary, legacy, tamper, and A/B lifecycle tests
  added; focused unit suite and backend typecheck green.
- [x] Schema/migration and policy implementation complete.
- [x] Focused tests and full backend E2E green.
- [x] Independent code, test, and security reviews complete; registry mutability,
  durable A/B reload, negative-state coverage, pricing-instant evidence, and
  history assertions remediated and reverified.
- [x] Aggregate validation green, including sequential full workspace suites,
  typecheck, lint, production build, agent-harness and documentation checks.
- [x] PR #52 open with final-head CI green (run 33074037524), retargeted to main, delivered, and merged to main (merge commit 589598f735012d01c53dc202c43f6fdb23efb509).

## Blockers

None. This plan is complete.
