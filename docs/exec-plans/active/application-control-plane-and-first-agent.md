# Application control plane, knowledge foundation, and the first production agent

## Goal

Deliver the application control plane, a tenant-isolated retrieval foundation,
knowledge management, and the first real production agent — `content-idea@1` —
as seven stacked pull requests, each independently reviewable and each leaving
`main` mergeable.

The architecture must stay application-owned. Mastra, pgvector, and the model
and embedding providers are adapters behind application ports; replacing any of
them must not require rewriting the business APIs, the `AgentRun` lifecycle,
authorization, idempotency, feature flags, runtime settings, knowledge, tool
contracts, or the input and output schemas.

## Context

`main` at `4c0c8fd` has a generic `AgentRun` lifecycle with attempt fencing,
transactional-outbox delivery, terminal transport reconciliation, and a Mastra
runtime adapter — and no product on top of it. Verified against source during
discovery rather than assumed:

- `PRODUCTION_AGENT_DEFINITIONS` is an empty array
  (`apps/backend/src/agents/definitions/index.ts`).
- `AgentDefinition` carries five flat fields and no schema of any kind; input
  and output are an untyped recursive JSON union.
- There is no agents HTTP surface at all, and no authorization on
  `AgentRunService.create`, which says so in its own doc comment.
- There is no provider-credential mechanism anywhere. Mastra's gateway resolves
  keys from `process.env` itself, which would bypass both the Zod config
  boundary and the runtime-env inventory.
- Idempotency-key reuse with a *different* body silently returns the original
  run. The hazard is documented in `agent.types.ts` and explicitly assigned to
  "the first HTTP boundary", which does not exist yet.
- There is no way to create the first `super_admin`: no seed, no CLI, no
  first-run path, and `auth.api.setRole` requires a session that cannot exist.

## Scope

Seven stacked PRs, each branching from the previous green head:

| PR | Branch | Scope |
| --- | --- | --- |
| 1 | `feat/bootstrap-super-admin-cli` | First-run super-admin CLI |
| 2 | `feat/control-plane-core` | Feature flags, typed runtime settings, managed secrets, resolver |
| 3 | `feat/platform-control-plane` | Platform UI for the above |
| 4 | `feat/knowledge-rag-core` | Knowledge domain, pgvector adapter, scoped retrieval |
| 5 | `feat/knowledge-management` | Spaces, documents, ingestion, embedding pipeline, UI |
| 6 | `feat/content-idea-agent` | `content-idea@1`, context assembly, business endpoints |
| 7 | `feat/content-idea-platform` | Platform workflow for generating and reading ideas |

## Non-goals

No generic agent framework, plugin discovery, MCP, LangGraph adapter, workflow
engine, event bus, multi-agent orchestration, conversational memory, checkpoint
framework, eval platform, tool side-effect ledger, or separate vector database.
No external side-effecting tools of any kind: the platform accepts duplicate
model execution and has no durable tool-side-effect ledger, so a tool that sends
an email or writes to a CRM has no safe semantics yet.

No hard cancellation. Disabling a feature flag stops acceptance of new work; it
does not cancel accepted `AgentRun`s, whose durable contract is unchanged.

## Constraints

- PostgreSQL stays business authority; Redis stays disposable coordination.
- Accepted async work is committed with an outbox event before any publish.
- The API composition root must remain unable to consume queue work.
- Attempt fencing and terminal reconciliation must not regress.
- Mastra imports stay confined to `agents/runtime/mastra/**`.
- `/etc/ai-agent/runtime.env` is never read, printed, copied, or modified. The
  control plane is an addition beside bootstrap env, not a replacement for it.
- Managed secrets are never returned after creation, never logged, and never
  placed in `process.env`; they are injected explicitly into adapters.
- Agent behavior stays versioned in code. Operational settings may be dynamic.

## Decisions taken before implementation

- **Provider stack: OpenAI for both generation and embeddings.** Chosen by the
  product owner from four options. It fixes the pgvector column at
  `vector(1536)` — `text-embedding-3-small` native, also reachable by
  `text-embedding-3-large` through its `dimensions` parameter, so two further
  models remain available without a table rewrite.
- **Evaluation runs offline in CI with an opt-in live mode.** Schema, isolation
  and context-policy assertions use a fake provider and need no credential; the
  same fixtures can be run against the real provider locally. CI never holds a
  provider key and cannot flake on model output.
- **pgvector arrives as `pgvector/pgvector:pg16`.** Verified: the extension is
  absent from `postgres:16-alpine`, pgvector publishes no Alpine variant, and
  the image is referenced in exactly three places that must change together.
- **The extension is created by a hand-written migration**, not by Prisma's
  `postgresqlExtensions` preview feature, which was deprecated in 6.16.0 and
  removed from current documentation even though the installed 7.9.1 CLI still
  accepts it.
- **Exact vector search first, no ANN index.** Verified that Prisma cannot
  represent HNSW or IVFFlat and actively emits `DROP INDEX` for them on every
  subsequent `migrate dev`. Exact search needs no index, so the problem does not
  arise until measured evidence says it must.
- **TypedSQL is not adopted.** It remains preview in 7.9.1 and requires a live
  database connection at generate time, which would put a pgvector-capable
  PostgreSQL into the client-generation step of CI to type two or three queries
  that `$queryRaw<T>` types by hand.

## Acceptance criteria

Each PR: scoped to its own increment, based on its intended parent, green
final-head CI, owning documentation updated in the same change, no unresolved
correctness or security finding from the code, test, and security reviews.

The program: a real `content-idea@1` registered in
`PRODUCTION_AGENT_DEFINITIONS`, reachable through an authorized business
endpoint, gated by `agents.enabled` and `content_ideas.enabled`, returning
schema-validated output built from organization-scoped retrieved context, with
cross-tenant isolation proven by negative tests.

## Validation

`pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm --filter backend test:e2e`, `pnpm build`, `ops/tests/documentation.sh`,
`git diff --check`, plus Prisma validation, generation and committed-client
drift checks on any PR touching the schema, and the container topology scripts
on any PR touching compose or images.

## Decision log

- 2026-08-22: The provider question was put to the product owner rather than
  inferred. Nothing in the repository named an intended provider, and the choice
  fixes a pgvector column dimension that is a table rewrite plus a full
  re-embedding to change — not a reversible default.
- 2026-08-22: PR1 creates a third composition root (`CliModule`) rather than a
  flag on `AppModule`, following the worker's precedent. Running it revealed two
  transitive dependencies that reading the module graph had not: mail renders
  localized templates, so the auth stack needs the i18n provider, and
  `MailService` needs `PinoLogger`. Both are now imported, the logger at
  `silent`, because the command's audience is a terminal.
- 2026-08-22: PR1 reaches Better Auth's `createUser` through a narrow port with
  a runtime guard rather than an unguarded cast. `AppAuth` is deliberately the
  library's base `Auth` type and the factory's `plugins` array is assembled
  conditionally, so the admin plugin's endpoints cannot be inferred; widening
  the factory's return type was tried and does not recover them. The guard turns
  a renamed endpoint into a stated error instead of an `undefined is not a
  function` inside a command holding a plaintext password.
- 2026-08-22: The bootstrap lock is a PostgreSQL advisory lock on a dedicated
  `pg` connection. The check is over an *absence*, so no row can be locked and
  no unique constraint can express it while the role column is a
  Better-Auth-owned comma-separated string. It is not taken through Prisma
  because a session-level advisory lock belongs to one connection and Prisma
  pools them. `pg_try_advisory_lock` rather than the blocking form, so a second
  operator is told a bootstrap is running instead of waiting and then being told
  the work is already done.
- 2026-08-22: The command refuses `--password` rather than accepting it. The
  threat is persistence, not interception: a flag lands in shell history and in
  `ps`, and an environment variable survives in `/proc/<pid>/environ` and in any
  crash reporter that serializes the environment. A TTY prompt without echo and
  a pipe are the only two mechanisms that leave nothing behind.

## Progress

- [x] Intake and discovery across auth/RBAC/CLI, the agent subsystem, database
  and container topology, the Platform app, and current Prisma/pgvector
  documentation — all evidence-backed against installed source.
- [ ] PR1 `feat/bootstrap-super-admin-cli`
- [ ] PR2 `feat/control-plane-core`
- [ ] PR3 `feat/platform-control-plane`
- [ ] PR4 `feat/knowledge-rag-core`
- [ ] PR5 `feat/knowledge-management`
- [ ] PR6 `feat/content-idea-agent`
- [ ] PR7 `feat/content-idea-platform`

## Blockers

None currently.
