# Organization agent installations and immutable versions

## Goal

Add the smallest durable organization-owned installation and immutable
configuration-version foundation for code-owned agents, without changing how
runs resolve effective configuration yet.

## Context

Main already owns immutable code definitions through
`AgentDefinitionRegistry`: `(agentId, definitionVersion)` resolves one exact
runtime definition, and `AgentRun` pins that pair. There is no durable answer to
which agents an organization has installed, whether one is enabled, or which
organization-specific configuration is currently effective.

AGT-01 is independent from ORG-01 and AUD-01. It consumes only main's
Organization, path-scoped organization authorization, AgentDefinition registry,
Prisma, and HTTP conventions. AGT-02 is the real child: it will make run
acceptance reference the effective immutable installation version introduced
here.

## Scope

- Add one installation per `(organizationId, agentId)` and append-only
  organization-agent version rows.
- Add a mutable active-version pointer and optimistic installation revision;
  changing enabled state, definition revision, or organization configuration
  creates a new immutable version and atomically switches the pointer.
- Extend code-owned `AgentDefinition` with an optional installation
  configuration contract: a Zod schema plus an application-owned default.
- Make the production `content-idea@1` definition installable with a strict
  empty configuration. This establishes schema ownership without inventing
  settings the current runtime does not consume.
- Add an authorized catalog/list/create/replace/version-history HTTP surface.
- Add schema, migration, unit/E2E, tenant-isolation, concurrency, immutability,
  and configuration-boundary tests.
- Update the narrow owning backend/database/security/feature documentation.

## Non-goals

- Pinning AgentRun to an installation/version or changing content-idea
  acceptance/execution. AGT-02 owns that transaction and worker contract.
- Product-audit events. AUD-01 is a separate sibling and AGT-01 does not depend
  on or duplicate it.
- A generic plugin framework, MCP marketplace, workflow builder, multi-agent
  framework, runtime-owned configuration, or agent-definition database table.
- Tools, prompts, model/provider selection, credentials, knowledge policy,
  schedules, billing, quotas, rollout percentages, or arbitrary metadata.
- A Platform installation screen. The bounded authorized API is this
  foundation's management surface; UI scope requires a separately justified
  product slice.
- Deleting installations or versions, downgrading migrations, or operating any
  environment.

## Constraints

- Agent definitions remain immutable code. The database references an exact
  registered `(agentId, definitionVersion)` but never becomes definition
  authority.
- Organization configuration is parsed by the selected code definition's Zod
  schema before persistence. There is no generic JSON acceptance path and this
  store must never contain provider credentials or secrets.
- One installation belongs to one organization and one agent id. Every read
  and mutation includes the path organization in its database predicate.
- The active pointer uses a composite foreign key to `(version.id,
  version.installationId)`, so one installation cannot point at another's
  version. Version ownership is likewise enforced by the installation's
  `(id, organizationId)` key.
- Version rows are immutable through the application. There is no update/delete
  method or route; only the installation's pointer/revision changes.
- A real replacement switches the active pointer and inserts its version in one
  PostgreSQL transaction. Losing concurrent work inserts no candidate row.
- PostgreSQL enforces one immutable row per `(installationId, revision)` with a
  compound unique constraint. A deferred active-pointer foreign key lets the
  service run pointer CAS before inserting the candidate, so CAS remains the
  concurrency decision and uniqueness independently rejects duplicates.
- No-op replacements do not increment revision or add history. Stale requests
  matching the winner are idempotent successes; stale different requests are
  conflicts.
- Catalog and installation lists are bounded by the finite code registry and
  unique installation-per-agent constraint. Version history defaults to 25,
  caps at 100, and keyset-pages on `(createdAt, id)` descending.
- The migration is additive and rollback-compatible with the current main
  application.

## Architecture and decisions

- `OrganizationAgentInstallation` stores organization, stable agent id,
  integer revision, nullable active-version pointer, and timestamps. The pointer
  is nullable only to permit installation/version creation within one
  transaction; every service-created committed installation has one.
- `OrganizationAgentVersion` stores installation/organization identity,
  installation revision, exact code definition version, enabled state, parsed
  configuration JSON, creator attribution, and creation time. No runtime/model/
  prompt snapshot is copied: the immutable code definition pair remains that
  authority.
- `createdByUserId` is attribution without a foreign key. A historical version
  must not block or lose attribution during a future user-lifecycle change.
- The content-idea definition declares a strict empty configuration and `{}`
  default. An empty schema is deliberate: current behavior has no legitimate
  organization knob, and a fake setting would become durable product contract
  without a consumer.
- `AgentDefinitionRegistry` exposes installable catalog summaries and exact
  configuration parsing. It never falls back from a requested definition
  version to latest. The catalog identifies the latest installable version per
  agent; an explicit historical registered version may be selected on replace.
- `POST /organizations/:organizationId/agent-installations` creates revision 1
  and makes it active. `PUT .../:installationId` is a strict full replacement
  with `expectedRevision`, `definitionVersion`, `enabled`, and configuration.
  `GET` collection returns current installations; `GET .../:id/versions`
  returns bounded immutable history.
- Management and history reuse `organization:update`. Installing, enabling,
  disabling, or changing configuration is organization administration, and the
  history exposes the same configuration. Admins/owners may use it; members,
  outsiders, and non-member global operators may not.
- Concurrent replacements generate a candidate id and compare-and-swap the
  pointer before inserting its version. The pointer foreign key is deferred to
  commit, so the CAS loser writes no candidate; a winner's later insert failure
  rolls the pointer update back. The service then re-reads once to distinguish
  an identical winner from a real conflict.

## Acceptance criteria

- Owners/admins can list the installable catalog, install a registered agent,
  list current installations, replace its effective version/configuration, and
  page immutable history.
- Members receive 403; outsiders and non-member global administrators receive
  404; guessed installation ids and cross-tenant ids reveal nothing.
- Installing an unknown/uninstallable agent or selecting an unregistered
  definition revision is refused without persistence.
- Configuration is parsed by the exact definition schema. The current strict
  empty content-idea schema refuses unknown keys, including a secret-like
  canary, and no arbitrary request field reaches JSON storage.
- A unique organization/agent constraint prevents duplicate installations.
- Each real replacement adds exactly one immutable version, increments the
  installation revision, and atomically switches the pointer.
- Two versions in one installation cannot share a revision, while revisions
  may repeat across different installations.
- Enabled-state changes are versioned rather than overwritten. A disabled
  current version remains durable and explainable.
- No-op/repeated identical replacements create no extra version. Concurrent
  different replacements yield one success/one conflict/one committed version;
  concurrent identical replacements yield idempotent success and one version.
- The database rejects an active pointer to a version from a different
  installation and rejects a version whose organization disagrees with its
  installation.
- No application update/delete operation exists for version rows or delete
  operation for installations.
- AgentRun, outbox, worker, Mastra, and current content-idea behavior are
  unchanged in this PR.

## Validation

- Focused registry/service tests for catalog, exact definition lookup,
  configuration parsing, create, no-op, replacement, CAS loss, and rollback.
- Backend E2E for authorized management/history, negative roles,
  cross-tenant ids, guard-before-pipe behavior, strict config/canary refusal,
  duplicate installation, immutability, and concurrent replacements.
- Direct database constraint assertions for cross-installation active pointers
  tenant-disagreeing versions, duplicate same-installation revisions, and
  valid repeated revisions across installations.
- Prisma format, validate, generate, current/empty migration deployment and
  migration-status checks.
- `pnpm agents:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter backend test:e2e`
- `pnpm build`
- `ops/tests/documentation.sh`
- `git diff --check`

## Required evidence

- Focused unit/E2E output and direct database constraint results.
- Negative authorization/tenant/configuration evidence and concurrency counts.
- Migration SQL/schema diff and clean generated-client evidence.
- Final reviewed diff, commit SHA, PR URL/base/head, and final-head GitHub
  checks.

## Risks and rollback

- A JSON configuration column can become arbitrary runtime authority. Exact
  definition-owned schemas, strict current configuration, and canary tests keep
  this boundary explicit; widening a definition is a code review event.
- Nullable `activeVersionId` permits cyclic installation/version creation. The
  service transaction is the only create path and never commits null; reads
  fail loudly if the invariant is violated rather than guessing a version.
- Concurrent requests may generate candidate ids, but pointer CAS happens before
  version insertion. CAS failure throws without writing a candidate; concurrency
  E2E asserts no orphan or duplicate version commits.
- The active-pointer foreign key is `DEFERRABLE INITIALLY DEFERRED`, while
  revision uniqueness remains immediate. CAS therefore runs before candidate
  insertion, avoiding unique-key contention and leaving no loser candidate;
  commit still refuses dangling/cross-installation pointers.
- The previous application ignores both additive tables. Rollback is the
  current main image; tables remain until a separately planned contraction.

## Progress

- [x] Shared discovery and dependency graph
- [x] Design and acceptance contract
- [x] Schema and migration
- [x] Definition configuration contract and registry
- [x] Installation/version service and API
- [x] Tests and documentation
- [x] Focused validation
- [x] Self-review and specialist reviews
- [x] Aggregate validation
- [x] PR handoff

## Decision log

- 2026-08-27: AGT-01 is an independent sibling on main. Organization identity,
  authorization, and code-owned definition/version foundations already exist;
  no ORG-01/AUD-01 contract is required.
- 2026-08-27: AGT-02 remains the only child because AgentRun will reference the
  immutable organization-agent version and validate tenant ownership during
  acceptance/execution.
- 2026-08-27: Enabled state is part of each immutable organization version, not
  a mutable boolean beside history, so every effective-state change remains
  explainable.
- 2026-08-27: Current Prisma documentation confirms compound unique constraints
  can back multi-field relations. The schema will use composite references to
  bind both version ownership and the active pointer in the database.
- 2026-08-27: No Platform UI is included. The management/read API establishes
  the bounded foundation without speculative navigation or configuration UX.
- 2026-08-27: Focused review replaced insertion-order-sensitive JSON comparison
  with structural equality and made catalog defaults pass through the owning
  definition schema before exposure. Focused unit (19 assertions across the
  service and composition suites) and E2E (11 cases) are green.
- 2026-08-27: Review hardening added database uniqueness for
  `(installationId, revision)`. Focused falsification found that deferring the
  unique constraint deadlocked identical replacements, so the final design
  defers the active-pointer foreign key and performs CAS before candidate
  insertion. Direct database and concurrency tests verify uniqueness scope,
  CAS conflict semantics, idempotency, and absence of orphan candidates.
- 2026-08-27: Aggregate validation is green: agent harness, monorepo typecheck,
  lint, 1,094 backend unit tests, 766 Platform tests, 26 web tests, 558 backend
  E2E tests, all-app production build, documentation assertions, Prisma
  validation/generation, current and fresh-database migration deployment, and
  diff checks. The first unit/build invocations exposed only missing local test
  environment and stale worktree Next cache; both passed unchanged under the
  CI-equivalent environment and a recoverable clean-cache build.
- 2026-08-27: Implementation commit
  `d8ae26d8c759eb884c5df3f3cb4cb5ca941deff0` was pushed and PR #48 opened
  against `main`. The plan is complete; final-head CI remains an external PR
  gate recorded in the local train dashboard.

## Blockers

None.
