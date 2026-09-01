# Governed durable tool execution

## Goal

Deliver TOOL-01, the first technical capability slice under the bounded
portfolio finish line: a code-owned Tool Registry, exact versioned grants
narrowed per organization and pinned to the accepted run, one real read-only
tool, and durable `ToolExecution` records — with the authority for every check
held by the application rather than by the runtime SDK.

## Context

`AgentRuntime` already exists as a replaceable application boundary with a
Mastra adapter behind it, and `AgentRun` already pins the definition revision,
the immutable `OrganizationAgentVersion`, the model, the policy, and the pricing
revision. Knowledge retrieval is already application-owned: `ContextPolicy`
declares the maximum visibility on the immutable definition,
`AgentContextAssembler` resolves slugs against the caller's own organization,
and `KnowledgeRetrievalService` enforces an operator-owned chunk ceiling.

What the repository cannot yet demonstrate is an agent *acting* — calling a
governed capability mid-generation — with the tenant boundary, the grant, the
schemas, and the durable record all owned by the application. Turning on tools
is the point where a model stops being a text generator and becomes a caller,
and a caller is untrusted. That is the capability TOOL-01 proves.

The existing pins are the reason this can be a small slice. A run already names
the exact `OrganizationAgentVersion` it was accepted under, so grant pinning
needs no new snapshot: the authority is already durable and already immutable.

## Scope

- A code-owned tool registry: stable id, positive immutable version, bounded
  description, Zod input and output schemas, and a `read_only` / `side_effect`
  risk classification. Only `read_only` is executable in TOOL-01.
- One exact first identity, `knowledge.search@1`, implemented over the existing
  application-owned Knowledge path.
- `AgentDefinition.maxToolGrants`: the maximum exact tool versions an immutable
  definition revision may use. Absent means none.
- `OrganizationAgentVersion.toolGrants`: the organization's selected exact
  grants, immutable per version, validated as a subset of the pinned
  definition's maximum.
- A durable `ToolExecution` record in PostgreSQL with a tenant-safe composite
  foreign key to `AgentRun`.
- One application-owned `ToolGateway` that holds every authority check and
  hands the runtime nothing but named, pre-authorized closures.
- The smallest generic runtime-tool contract on `AgentRuntimeRequest`, and a
  Mastra adapter translation for it.
- An explicit, code-owned bound on tool calls per generation.

## Non-goals

- No side-effecting tool, no Human Approval, no approval tables, no provider
  idempotency, no external-effect reconciliation. That is ACT-01, and
  pre-building any of it here would be designing against a guess.
- No `ToolExecution` reconciler. A read-only execution left `STARTED` by a
  process death is an honest "outcome unknown" for a harmless operation.
- No MCP, no generic tool HTTP endpoint, no tool marketplace, no user-defined
  or dynamically loaded tools, no plugin callbacks, no workflow engine, no
  scheduler, no tool UI, no second runtime, no new product agent.
- No behavior change to `content-idea@1`, and no grant to it. Its automatic
  RAG path stays exactly as it is.
- No database `ToolDefinition` table. The registry is code.
- No control-plane setting for the tool-call bound unless a need is shown.

## Constraints

- The model is an untrusted caller. It may name a tool and supply that tool's
  input, and nothing else. Organization id, run id, version id, grants, tenant
  scope, and implementation callbacks all come from application execution
  context.
- Even though Mastra validates tool schemas itself, the gateway parses again.
  An SDK's validation is not the application's guarantee.
- Cross-organization reference must be refused by PostgreSQL through a
  composite `(agentRunId, organizationId)` foreign key, not by a service
  predicate.
- Exact tool id and version are columns. An SDK tool name is never authority.
- A failure record carries a closed application-owned code. No stack, no
  provider error, no `error.message`, no raw SDK response — in the record or in
  a log.
- Grants are read from the run's already-pinned `OrganizationAgentVersion`. No
  duplicated snapshot on `AgentRun` unless discovery proves the pin insufficient.
- Additive migration only, forward-only, rollback-compatible with the preceding
  image.

## Acceptance criteria

- [ ] Registry composition fails loudly on duplicate `(toolId, version)`,
      invalid identity, and a definition grant naming an unregistered tool
- [ ] `OrganizationAgentVersion.toolGrants` ⊆ pinned `AgentDefinition.maxToolGrants`,
      with duplicates and unknown tools rejected
- [ ] Existing definitions and existing organization versions have zero grants
- [ ] A run executes the grants of the version it was accepted under, proven in
      both directions: a later removal does not retract, a later addition does
      not confer
- [ ] `ToolExecution` records `STARTED` only after authority, grant, and input
      validation, and before the implementation runs
- [ ] Cross-tenant `ToolExecution` insert refused by PostgreSQL in raw SQL
- [ ] `knowledge.search@1` returns only the caller organization's allowed
      spaces, respects the chunk and character budgets, and cannot be pointed
      at a scope by its caller
- [ ] Only effective tools reach the runtime; a non-granted call fails closed
- [ ] Tool calls per generation are explicitly bounded
- [ ] `content-idea@1` behavior is unchanged
- [ ] No raw error text reaches a failure field or a log

## Validation

`pnpm agents:check` · `pnpm typecheck` · `pnpm lint` · `pnpm test` ·
`pnpm --filter backend test:e2e` · `pnpm build` · `ops/tests/documentation.sh` ·
`git diff --check`, plus `prisma validate`, `prisma generate` with idempotence,
migrations from zero, and `migrate diff` = zero. Focused tool, grant, tenant,
and runtime tests run before the aggregate suite.

## Required evidence

- Focused test output for registry, grants, pinning, tenancy, schemas,
  durability, knowledge scoping, and the runtime boundary.
- Migration-from-zero and zero-drift output.
- Rollback compatibility argument for the additive schema change.
- Mastra version-specific evidence for the tool API and the loop bound.
- Specialist review findings and their remediation.

## Decision log

- **Grants are read from the existing `OrganizationAgentVersion` pin.** A run
  already names its immutable version, and that version is the authority. A
  second snapshot on `AgentRun` would be a copy of a fact already durable and
  already immutable, and two copies of one fact is how they diverge.

## Progress

- [x] Discovery
- [x] Execution plan committed
- [ ] Tool registry
- [ ] Definition maximum grants
- [ ] Organization effective grants and migration
- [ ] ToolExecution durability
- [ ] ToolGateway
- [ ] knowledge.search@1
- [ ] Runtime contract and Mastra adapter
- [ ] Tool-loop bound
- [ ] Tests
- [ ] Documentation
- [ ] Specialist reviews and remediation
- [ ] Aggregate validation
- [ ] PR and final-head CI

## Blockers

None.
