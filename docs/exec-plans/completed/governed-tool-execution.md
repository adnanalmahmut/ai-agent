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

- [x] Registry composition fails loudly on duplicate `(toolId, version)`,
      invalid identity, and a definition grant naming an unregistered tool
- [x] `OrganizationAgentVersion.toolGrants` ⊆ pinned `AgentDefinition.maxToolGrants`,
      with duplicates and unknown tools rejected
- [x] Existing definitions and existing organization versions have zero grants
- [x] A run executes the grants of the version it was accepted under, proven in
      both directions: a later removal does not retract, a later addition does
      not confer
- [x] `ToolExecution` records `STARTED` only after authority, grant, and input
      validation, and before the implementation runs
- [x] Cross-tenant `ToolExecution` insert refused by PostgreSQL in raw SQL
- [x] `knowledge.search@1` returns only the caller organization's allowed
      spaces, respects the chunk and character budgets, and cannot be pointed
      at a scope by its caller
- [x] Only effective tools reach the runtime; a non-granted call fails closed
- [x] Tool calls per generation are explicitly bounded
- [x] `content-idea@1` behavior is unchanged, including the generation options
      it is invoked with
- [x] No raw error text reaches a failure field or a log
- [x] A terminal `ToolExecution` transition is a compare-and-set on `STARTED`
      that requires exactly one row, and fails closed when none transitions
- [x] A failed tool transmits nothing to the provider but the application's own
      sentence, proven against the real installed SDK
- [x] A malformed or truncated tool argument reaches no console sink, proven
      against the real installed SDK
- [x] Provider-facing failure prose names the audited `runtimeName`, not the
      durable identity

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
- [x] Tool registry
- [x] Definition maximum grants
- [x] Organization effective grants and migration
- [x] ToolExecution durability
- [x] ToolGateway
- [x] knowledge.search@1
- [x] Runtime contract and Mastra adapter
- [x] Tool-loop bound
- [x] Tests
- [x] Documentation
- [x] Specialist reviews and remediation
- [x] Aggregate validation
- [x] PR and final-head CI

## Blockers

None.

## Discovery evidence

The Mastra tool API was read out of the installed `@mastra/core@1.61.0` rather
than from documentation, and two findings changed the design:

- **Tool records are keyed by the model-facing name, and `Agent.formatTools`
  silently rewrites any key outside `^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`.** Both `.`
  and `@` are rewritten, so the durable identity `knowledge.search@1` would have
  reached the provider as `knowledge_search_1` — a name nobody reviewed. Tools
  therefore declare an explicit audited `runtimeName`, checked at composition
  and again in the adapter. A real-SDK test demonstrates the rewrite.
- **The agent loop's step ceiling defaults to `stepCountIs(5)`, a runtime
  literal declared in no `.d.ts`.** `maxSteps` is passed explicitly on a
  tool-enabled generation. Passing only `stopWhen` would have *replaced* the
  default and removed the ceiling entirely, so `maxSteps` is the right
  mechanism. A generation with no tools passes none and keeps the options it
  had before this change, because `maxSteps` composes into the loop's stop
  conditions rather than being inert.

A third fact emerged during review and changed the containment design: Mastra
catches everything a tool throws except its own `FGADeniedError` and turns it
into a tool *result* and continues. A thrown tool error is therefore outbound
material to a provider, not a failure signal. Reading the installed bundle
resolved it into three steps: `Tool.execute` wraps the throw in a `MastraError`
keeping the original as `cause`; `serializeToolError` builds
`{ name, message, stack, ...own enumerable properties }` from that wrapper; and
`createToolModelOutput` renders the result to the model — as the message alone
for an application-executed tool, as the object for a `providerExecuted` one.

A fourth fact closed the remaining gap, and it runs the other way. Mastra's
chunk transform calls `console.error` with the model's raw tool-call argument
string when that string is unparseable and unrepairable — bypassing the
adapter's logger containment and Pino's redaction, and reachable through
ordinary `maxOutputTokens` truncation rather than through an attack. Tool
arguments are model-generated from tenant input and retrieved passages, so this
is tenant material in container logs. The emission is unconditional, has no
hook, and is unchanged in the newest release, so a pinned pnpm patch replaces
that one line with a bounded constant.

The wrapper is why the containment type controls less than it appears to: the
serialized `name` and own properties are the wrapper's whatever the thrown class
looks like. Two things are therefore load-bearing and both were measured, not
argued. The constant message bounds what the provider is told. Discarding the
type's own stack bounds what the serialized failure carries, because the wrapper
keeps the application error reachable as `cause` and a stack there renders this
repository's source paths into every consumer of the chunk.

## Review outcomes

Three specialist reviews ran. The security and code reviews independently found
the same highest-severity issue, which is the strongest signal either produced.

**Containment of durable-write failures (both reviews, high).** The four
`ToolExecutionService` calls sat outside any `try`. Given the SDK behavior
above, a Prisma rejection — which renders the connection target and, for an
argument fault, the invocation arguments — would have been transmitted to the
provider as tool-result text, with the run still able to succeed and nothing
logged. Everything a tool call can emit is now contained to a constant naming
the tool.

**The tool-call loop was not bounded (security, medium).** `maxSteps` bounds
model round-trips; one assistant step may emit many tool calls and the SDK runs
them all. The input schema stops the model choosing how much a search retrieves;
nothing stopped it choosing how many searches. Capped per run attempt.

**Framing asymmetry (security, medium).** The same corpus reached the model
fenced through the prompt and bare through a tool result. The tool description
now carries the same "quoted material, no instructions" framing. The passages
themselves are deliberately *not* escaped the way the prompt's are: a tool result
is serialized JSON with no delimiter to break out of, so escaping would damage
legitimate content to defend against nothing.

**Three unverified guards (test review, moderate).** Proven unverified by
mutation: the recorded attempt number, the use of the parsed rather than raw
value, and the duplicate-grant refusal. All three now have tests that fail when
the guard is removed.

Smaller findings remediated: the tenant predicate now reaches the update side; a
`side_effect` tool fails the build rather than every run of whichever agent named
it; the closure re-verifies its authorization rather than only claiming to; the
passage bound derives from the operator ceiling rather than coinciding with it;
dead exports removed. Four comments made false factual claims and were corrected.

**A process failure worth recording.** The test-engineer review ran mutations in
the same worktree that was being edited and committed, and one mutation
(`agentRunAttempt: 1`) was captured in commit `99f5497`. The review reported it;
the commit was amended and the branch audited for other contamination, of which
there was none. Mutation testing needs an isolated worktree.

## Verified evidence

- `pnpm agents:check` — passed, 113 harness tests.
- `pnpm typecheck`, `pnpm lint` — clean, no `--fix` in verification.
- `pnpm test` — backend 1365, platform 850, web 2 files.
- Backend e2e — 677/677 across 32 suites, twice.
- `prisma validate`; `prisma generate` idempotent; migrations from zero on a
  fresh database; `migrate diff` exit 0.
- Rollback compatibility proven by executing an old image's column-omitting
  `INSERT` against the migrated schema: accepted, and the value defaults to the
  empty list. Also asserted as a test.
- Cross-tenant `tool_execution` insert refused by
  `tool_execution_agentRunId_organizationId_fkey` with a positive control.

## Outcome

Delivered as PR #60 on `feat/governed-tool-execution`, based on `main` at
`ec3d82d1df277b7a74462b3f1f9d4c03b0cb4c0f`, independent.

Four portfolio exit criteria are met: the governed registry, one real read-only
tool, durable `ToolExecution`, and tenant/grant/schema enforcement. Gate P1 is
**not** met — it requires ACT-01, and nothing here proves a side effect, retry
without duplication, or human approval.
