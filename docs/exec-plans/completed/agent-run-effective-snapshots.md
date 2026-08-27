# Pin agent runs to effective organization-agent versions

## Goal

Make every newly accepted agent run durably reference the exact immutable
organization-agent version whose definition, enabled state, and validated
configuration govern that run, while preserving explainable execution for
legacy pre-AGT-02 runs.

## Context

AGT-01 introduced one organization-owned installation per agent, append-only
effective versions, and a transactional active pointer. AgentRun currently pins
only a caller-supplied code definition revision and runtime. It does not prove
that the agent was installed or enabled, identify the organization configuration
accepted for the run, or prevent a caller from combining one tenant's run with
another tenant's version.

This is a true child of AGT-01. The AgentRun foreign key, acceptance lookup, and
worker configuration reload directly consume OrganizationAgentVersion and its
installation identity from PR #48 final head
`9426f1a9aebcef43cf029af1dfc7189fe1d857f4`.

The approved rollout is Option A: explicit-installation cutover. An
organization being permitted to use an agent by the control plane does not mean
that organization has installed it. Installation is deliberate,
organization-owned product state and must not be manufactured by run
acceptance merely because a flag is enabled.

## Scope

- Add a nullable durable OrganizationAgentVersion reference to AgentRun and a
  composite foreign key that binds it to the run organization.
- Require every run accepted by the new application to resolve the currently
  active installation version inside the run/outbox transaction, refuse a
  missing or disabled installation, validate its exact registered definition
  and configuration, and derive definition revision/runtime rather than trust
  caller-supplied values.
- Preserve the existing organization advisory lock, capacity decision,
  idempotency lookup, run insert, and outbox append as one transaction.
- Make content-idea availability report not-installed and disabled states after
  the existing coarse/specific control-plane flags.
- Apply the explicit-installation cutover to new runs: no installation returns
  `agent_not_installed`, while an installed but disabled active version returns
  `agent_disabled`.
- Reload the pinned immutable version from PostgreSQL on every worker attempt,
  verify run/version organization, agent id, and definition revision, re-parse
  configuration with the pinned code definition, and pass the parsed value
  through the application-owned runtime request boundary.
- Keep the BullMQ payload as `{ runId }`; Redis carries no configuration or
  version authority.
- Add migration, unit/E2E, concurrency/transition, retry, tampering, rollout,
  tenant-isolation, and documentation coverage.

## Non-goals

- Changing installation/version management, adding agent settings, or adding
  a Platform installation-management UI. Until a later UI exists, an
  authorized caller uses the installation API before requesting a run.
- Copying configuration into AgentRun or a queue payload. The immutable version
  row is the durable snapshot and its id is sufficient.
- Changing input/output schemas, prompts, tools, knowledge policy, model/provider
  selection, credentials, schedules, billing, quotas, or the run state machine.
- A generic plugin, workflow, event-sourcing, or runtime-configuration system.
- Backfilling historical runs to guessed installations, automatically or
  lazily installing on first run, treating a feature flag as an installation,
  falling back to a global definition for a new run, or mutating immutable
  organization-agent versions.

## Constraints

- PostgreSQL remains configuration authority; the worker reloads by durable id
  and never trusts queue data beyond the run id.
- The run/version foreign key includes organization identity. Application reads
  additionally require matching agent id and definition revision through the
  version's installation before configuration is returned.
- New-run resolution uses the active pointer read in the same PostgreSQL
  transaction that inserts AgentRun and its outbox event. A concurrent pointer
  switch may linearize before or after that read; either answer is one real
  immutable version and remains fixed for the run.
- The entitlement gates remain distinct. Control-plane/feature permission is
  necessary but does not imply installation; explicit organization
  installation is also necessary, its active version must be enabled, and the
  immutable version must validate before the request may proceed.
- The idempotency lookup occurs before current-state resolution both outside and
  inside the organization advisory lock. A retry returns its already accepted
  run even if the installation was later disabled, removed from the registry,
  or switched to a different version.
- Every new run has a non-null version id by application invariant. The column
  is database-nullable for rolling/rollback compatibility with the previous
  image and for existing rows.
- A null version id means a legacy run accepted before AGT-02. Its historically
  correct effective configuration is the pinned code definition's validated
  default, never today's mutable installation state. This keeps rolling deploys
  executable without manufacturing a guessed version relationship.
- The legacy-null rule applies only to historical or rolling-rollback writes.
  New AGT-02 acceptance cannot use it as a global-definition fallback.
- Definition/configuration mismatches are deterministic application
  configuration failures: they are recorded final without retrying and expose
  no stored configuration or parser detail to logs or BullMQ.
- Agent configuration remains application-owned JSON and is passed parsed to
  the runtime adapter; the adapter does not select, reload, or validate it.
- The migration is additive and the previous image can continue reading and
  creating legacy-null runs after rollback.

## Architecture and decisions

- AgentRun gains `organizationAgentVersionId` and an optional relation on
  `(organizationAgentVersionId, organizationId)` to
  `(OrganizationAgentVersion.id, organizationId)`. The target gets the required
  compound unique key. The database therefore rejects a cross-tenant version
  reference while leaving old/null rows valid.
- AgentRunService accepts agent identity but no caller-owned definition revision
  or runtime. Under the existing transaction-scoped organization lock it first
  repeats idempotency lookup, resolves the unique installation plus active
  version, validates enabled state, exact registry revision, and configuration,
  then persists the derived revision/runtime/version id before appending the
  existing outbox event.
- The current installation check happens before capacity. Disabled/uninstalled
  state is the governing product answer; a spend ceiling does not hide it.
- Missing installation means `agent_not_installed`; installed with a disabled
  active version means `agent_disabled`; installed with an enabled, valid
  active version may continue through the other authorization, capacity, and
  acceptance gates. None of those paths creates or repairs installation state.
- AgentRunService exposes a worker-only configuration reload that predicates on
  version id, run organization, installation agent id, and definition revision.
  AgentRunner invokes it inside the handler's contained error boundary, parses
  the value again through the already-resolved definition contract, and passes
  it to AgentRuntime. Null legacy runs receive that definition revision's owned
  default.
- ContentIdeaService adds `agent_not_installed` and `agent_disabled` availability
  reasons. Control-plane flags remain first so the broad operator stop still
  explains the refusal when multiple gates are closed. The frontend reports
  the bounded state and never installs on the organization's behalf.
- No queue schema change is needed. The handler receives only run id, claims the
  row with its existing attempt fence, then the runner reloads the immutable
  version on every attempt. Retries and requeues cannot drift to the current
  installation pointer.

## Acceptance criteria

- A content-idea request is refused when content-idea is not installed or its
  active version is disabled, and availability reports the same bounded reason.
- An existing organization with no content-idea installation receives
  `agent_not_installed`; enabling either control-plane flag cannot change that
  answer or create an installation.
- A successful new request stores the exact active OrganizationAgentVersion id,
  its definition revision, and code-derived runtime atomically with the outbox
  event.
- Caller code cannot choose a version id, definition revision, runtime, enabled
  state, or configuration for AgentRun acceptance.
- A run accepted under version/configuration A still executes A after the
  organization switches its active pointer to B before the worker claims it.
- A second run accepted after the switch pins B. Retrying the first request key
  after the switch returns the original A-pinned run without a second outbox
  event.
- Every retry/requeue of one run reloads the same immutable version id from
  PostgreSQL; the BullMQ payload remains only the run id.
- The database rejects a run reference to another organization's version.
  Worker resolution refuses same-tenant agent-id or definition-version
  mismatches and refuses configuration that no longer satisfies the pinned
  definition schema.
- Legacy null-reference runs execute with the pinned definition revision's
  validated default configuration and never consult an active installation.
- Newly accepted runs never use the legacy-null path or a global-definition
  fallback, and run acceptance never creates installation/version rows.
- Members/outsiders retain the existing content-idea authorization behavior;
  no new public read or mutation route is introduced.
- Existing attempt fencing, terminal reconciliation, failure containment,
  capacity, idempotency, outbox, and current content-idea output behavior remain
  green.

## Validation

- Focused AgentRunService tests for effective lookup, disabled/missing refusal,
  derived definition/runtime, idempotent retry after switch, and atomic rollback.
- Focused AgentRunner/handler/runtime tests for version reload, exact identity,
  default legacy behavior, strict re-parse, safe deterministic failure, and
  configuration handoff.
- Backend E2E proving A remains pinned/executed after active switches to B,
  a new run pins B, retry/requeue stays on A, queue payload is id-only, and a
  concurrent switch yields one valid immutable snapshot.
- Direct database cross-tenant version-reference rejection and application
  cross-agent/revision tampering refusals.
- Content-idea E2E and Platform tests/messages for install/disabled availability.
- Prisma format, validate, generate, current/fresh migration deployment and
  status checks.
- `pnpm agents:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter backend test:e2e`
- `pnpm build`
- `ops/tests/documentation.sh`
- `git diff --check`

## Required evidence

- Persisted run/version ids before and after an active-pointer switch, runtime
  request configuration, retry/requeue identity, and outbox payload.
- Negative missing/disabled/tampered/cross-tenant results with no leaked
  configuration or extra durable work.
- Migration SQL/schema diff and current generated-client evidence.
- Final reviewed diff, commits, PR URL/base/head, and final-head GitHub checks.

## Risks and rollback

- A worker could accidentally consult the current pointer. Tests switch to B
  before claim and assert the runtime received A; the reload API accepts only
  the run's immutable id and never the installation id.
- The nullable rollout column could become an escape hatch for new runs. The
  create path has no caller field and always writes a resolved id; tests assert
  it. Null is handled only as the explicit legacy/default case.
- Implicit installation would fabricate organization-owned product state and
  make feature permission indistinguishable from product selection. Tests and
  owning docs keep the gates separate; the run service has no installation
  create path, and the frontend exposes no auto-install behavior.
- Configuration could leak through parser errors or logs. Definition/config
  mismatches are converted to the existing constant deterministic failure; no
  config value is logged, copied to AgentRun diagnostics, or sent through Redis.
- The previous image ignores the new nullable column and remains rollback
  compatible. Runs it accepts during rollback use the same code-owned default
  behavior that image historically executed when the new worker later sees
  them.

## Progress

- [x] Shared discovery and verified dependency/base
- [x] Design and acceptance contract
- [x] Schema and migration
- [x] Effective acceptance and availability
- [x] Worker reload and runtime handoff
- [x] Tests and documentation
- [x] Focused validation
- [x] Self-review and specialist reviews
- [x] Aggregate validation
- [x] PR handoff

## Decision log

- 2026-08-27: PR 4 is stacked on PR 3 because AgentRun directly references and
  reloads the OrganizationAgentVersion aggregate introduced by AGT-01. No other
  train edge is consumed.
- 2026-08-27: Resolution occurs at acceptance, not first worker claim. This is
  what proves a run created under A stays A if the organization switches to B
  before execution; delaying resolution to claim would silently choose B.
- 2026-08-27: The queue remains id-only. Durable version identity belongs in
  AgentRun/PostgreSQL and is reloaded on every attempt.
- 2026-08-27: The rollout column stays nullable and legacy runs use the pinned
  code definition's default configuration. Backfilling them to a current or
  guessed installation would rewrite history rather than explain it.
- 2026-08-27: Option A, explicit-installation cutover, is the product decision.
  No backfill, automatic/lazy/first-run install, feature-flag-as-install, or
  global-definition fallback is allowed for new runs. The management UI is
  deferred; authorized API installation is the prerequisite in this train.
- 2026-08-27: Database identity binds tenant; application resolution also binds
  agent and definition revision. Duplicating agent identity onto immutable
  versions solely for a wider foreign key would make the preceding AGT-01 image
  unable to write after migration and violate rollback compatibility.
- 2026-08-27: Self-review made `organizationAgentVersionId` mandatory at the
  production `AgentRunner` boundary. Only explicit null is legacy; omission can
  no longer silently bypass pinned-version reload.

## Blockers

None.
