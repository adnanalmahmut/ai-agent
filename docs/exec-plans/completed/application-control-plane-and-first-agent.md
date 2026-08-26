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
- [x] PR1 `feat/bootstrap-super-admin-cli`
- [x] PR1 landing evidence: [#30](https://github.com/adnanalmahmut/ai-agent/pull/30),
  head `28bc6ec86ea90380778074043d2ff957b382a920`, CI run
  [32596855361](https://github.com/adnanalmahmut/ai-agent/actions/runs/32596855361)
  green across all five jobs.
- [x] PR2 `feat/control-plane-core` — [#31](https://github.com/adnanalmahmut/ai-agent/pull/31),
  head `42894f701068e8f289ef1b4631cd380943b30212`, CI run
  [32628412579](https://github.com/adnanalmahmut/ai-agent/actions/runs/32628412579)
  green across all five jobs.
- [x] PR3 `feat/platform-control-plane` — [#32](https://github.com/adnanalmahmut/ai-agent/pull/32),
  head `6d6fc2994d2481ef171d47726bb25c3610b61614`, CI run
  [32642515109](https://github.com/adnanalmahmut/ai-agent/actions/runs/32642515109)
  green across all five jobs.
- [x] PR4 `feat/knowledge-rag-core` — [#33](https://github.com/adnanalmahmut/ai-agent/pull/33),
  head `bce3af622e38861815e93af8ffec3d977ec559e5`, CI run
  [32645454031](https://github.com/adnanalmahmut/ai-agent/actions/runs/32645454031)
  green; merged as `f0eacfb`.
- [x] PR5 `feat/knowledge-management` — [#34](https://github.com/adnanalmahmut/ai-agent/pull/34),
  head `4143b5783c5647e4b688daef63f3b9befa22d354`, CI run
  [32660866809](https://github.com/adnanalmahmut/ai-agent/actions/runs/32660866809)
  green; merged as `734f095`.
- [x] PR6 `feat/content-idea-agent` — [#35](https://github.com/adnanalmahmut/ai-agent/pull/35),
  head `7fbf2c63f9267a99f6358209eef62ec3c2d81ea9`, CI run
  [32702017762](https://github.com/adnanalmahmut/ai-agent/actions/runs/32702017762)
  green; merged as `44c284e`.
- [x] PR7 `feat/content-idea-platform` — [#36](https://github.com/adnanalmahmut/ai-agent/pull/36),
  head `041b12f0195074fc462bdd592f8f480ee1c2b182`, CI run
  [32756064924](https://github.com/adnanalmahmut/ai-agent/actions/runs/32756064924)
  green; merged as `866845b`.
- [x] Hardening remediation `fix/milestone-hardening` — [#37](https://github.com/adnanalmahmut/ai-agent/pull/37),
  head `1a420bc15c54ea4102de8e5aa2a647e37acd65ff`, CI run
  [32865427701](https://github.com/adnanalmahmut/ai-agent/actions/runs/32865427701)
  green; merged as `b50b0f7`.

- 2026-08-23: PR2 stores feature-flag overrides in two tables rather than one
  with a nullable `organizationId`. PostgreSQL treats NULLs as distinct in a
  unique index, so the constraint that matters most — at most one platform
  override per key — would not have held, and it would have failed silently by
  permitting duplicates rather than loudly at write time.
- 2026-08-23: Nothing in the control plane is cached. For flags the reason is
  semantic: the promise is that disabling a feature stops acceptance
  immediately, and a TTL contradicts it exactly when an operator is switching
  something off because it is misbehaving. For secrets it is rotation: a cached
  credential outlives the rotation meant to retire it.
- 2026-08-23: Managed secrets record a fingerprint of the master key that sealed
  them. Without it, decrypting after `APP_ENCRYPTION_KEY` changed is an
  authentication failure indistinguishable from a corrupted row, and an operator
  would be told the data was tampered with when in fact they need to re-enter
  the credential.
- 2026-08-23: `APP_ENCRYPTION_KEY` was added to `ops/runtime-preflight.sh`'s
  required list. It is a deployment prerequisite: an environment without it
  fails preflight rather than booting and failing on the first secret read.
- 2026-08-23: PR2 security review raised four findings; three were repaired and
  one is deferred.
  - Repaired: `openSecret` pinned the GCM authentication tag to sixteen bytes
    and asserts the nonce length. Node accepts 4, 8, and 12-16 byte tags and
    verifies a short tag against a *prefix* of the correct one, so a row whose
    tag had been truncated to four bytes decrypted successfully — forgery at
    roughly 2^32 work for anyone with write access to the column. Reverting the
    guard fails six tests, one per length Node would otherwise accept.
  - Repaired: `reveal` now logs the decryption diagnosis at `warn`. It was only
    attached to an exception the caller renders as "credential unavailable", so
    the wrong-key-versus-altered-row distinction the fingerprint column exists
    to produce reached nobody.
  - Repaired: `resolve` no longer consults an organization override for a flag
    the registry does not scope to organizations. Writes were already refused,
    but a flag narrowed in code after overrides existed would still have been
    overridden by the rows written while it was legal.
- 2026-08-23: PR2 code review raised eight findings and the test review found
  three surviving mutants. All were repaired.
  - `ops/runtime-preflight.sh` now checks the master key's shape, not only its
    presence. `openssl rand -hex 32` yields 64 characters that are all valid
    base64 and decode to 48 bytes, so the old check passed it and the
    application refused it at `ConfigModule` init — after the migration
    container had already run. It is now a preflight refusal.
  - Rotating a managed secret no longer erases its label. An operator pasting a
    new key does not resubmit the note saying which account it belongs to, and
    an omitted label was being written as `NULL` to the only surface that shows
    it.
  - The settings read surface distinguishes "never configured" from "stored
    value no longer satisfies its schema". Collapsed, a bound tightened in code
    showed the default beside the date the operator set something else, with
    nothing to explain the disagreement and a reset button that appeared to do
    nothing.
  - An unknown `organizationId` is a 404. It was a 500 with a stack trace on
    write (an unmapped foreign-key violation) and a fabricated 200 on read.
  - Runtime setting values are typed `Prisma.InputJsonValue` rather than cast
    with `as never`. The cast hid that an `.optional()` registry entry would
    make `set()` answer 200 and change nothing, because Prisma reads
    `undefined` on an update as "leave this column alone".
  - The module barrel no longer re-exports the cipher primitives. They take a
    key as an argument, so exporting them let any feature encrypt or decrypt a
    credential outside the service that owns the fingerprint check and the
    failure contract.
  - Authorization is now proved by a route table rather than by sampling.
    Deleting `@UserHasPermission` from four routes left the whole suite green,
    because those routes were never probed. Every route is now swept against a
    platform `user`, a platform `admin`, an organization owner, and an
    anonymous caller, and a route added without a table row fails the sweep.
  - Deferred: control-plane writes have no audit trail. `updatedByUserId` is the
    only attribution and a delete removes it, so "who turned this off" is
    unanswerable after the fact. An append-only event recording actor, action,
    key and timestamp — never the value — belongs with the Platform surface in
    PR3, where there is a place to read it.

- 2026-08-23: The Platform control-plane screen loads each panel only when its
  tab is opened. The credentials listing is the most sensitive of the three and
  an operator reading about feature flags has no reason to request it.
- 2026-08-23: The credential input is cleared after every write, including a
  rejected one. A rejected value is still a credential, and a controlled input
  keeps it across re-renders and through a browser's form restore.
- 2026-08-23: The screen holds no opinion about a setting's bounds. The
  registry's schema is the only authority, and a client-side range would either
  refuse a value the server accepts or accept one it refuses; the operator reads
  the server's own reasons instead.
- 2026-08-23: `CONTROL_PLANE_PATH` lives in `apps/platform/src/config/paths.ts`
  rather than beside its callers. Written out it is `/platform/control-plane` —
  a backend route spelled identically to this application's own mount point and
  meaning something entirely different. The repository's architecture test
  catches the literal, and it is right to.

- 2026-08-23: `apiRequest` unwraps the backend's `{ success, data, meta }`
  envelope. It had never done so and nothing had noticed, because every caller
  that existed before the control plane returns `void` — no body had ever been
  read. The three panels would have received the envelope where they expected
  a list and crashed to the route error boundary on first render. The
  pre-existing test for this asserted against a bare array, a response the
  global `ResponseInterceptor` cannot produce, and so pinned the defect rather
  than catching it.
- 2026-08-23: A 401 is reported as an expired session, separately from a 403.
  The recoveries are opposites: signing in again fixes one, and nothing the
  operator can do fixes the other. Collapsing them tells someone who holds the
  role to go looking for it.
- 2026-08-23: The credential note is refused when it contains the credential
  being stored. The two inputs are stacked in one narrow column with only the
  upper one masked, so a paste landing a row too low is silent — and the note
  is stored unsealed and read back verbatim by anyone who can list the slots.
  Sending it would leave a live credential in a column AES-256-GCM never
  touches, in the database and in every backup. Nothing is sent when the note
  is refused; the operator is told why.
- 2026-08-23: A refused reset keeps the operator's draft, matching Save. The
  earlier asymmetry discarded their text on a write that had changed nothing.
- 2026-08-23: `CONTROL_PLANE_ERROR_KINDS` and `FEATURE_FLAG_SOURCES` are arrays
  rather than bare unions, so `messages.test.ts` can assert copy exists for
  every one. A union is gone at runtime, and what it leaves behind is a raw key
  path rendered into an error card.

- 2026-08-23: The hook's race guarantees are tested against the hook, not
  through the rendered screen. Every panel disables the row it is writing, so a
  second write to the same row cannot be issued from the Platform at all — a
  block-level test for a superseded response asserts a state the UI makes
  unreachable and fails for the wrong reason. The guarantee still has to hold,
  because the disabled button is UX and not an invariant, so it is asserted in
  `use-control-plane-resource.test.ts` where the property lives.

- 2026-08-23: PR4 will use exact vector search with no vector index, and the
  decision is now evidence-backed rather than a preference. Two independent
  reasons. First, recall: pgvector's own README states that an approximate
  index changes results, and a measured 50,000-row, 100-tenant reproduction
  returned 4 of 10 requested rows under HNSW with the default `ef_search`,
  because the tenant predicate is applied *after* the index scan. Second,
  durability: Prisma 7 emits `DROP INDEX` for a vector index on every
  subsequent migration — including one created by raw SQL inside a migration
  file — because `schema.prisma` cannot represent it. The index would silently
  disappear on a forward-only pipeline. A btree on `organizationId` is what
  pgvector's README recommends for a low-percentage filter, and is what will be
  used.
- 2026-08-23: The vector column must be declared `Unsupported("vector(1536)")?`
  — nullable. A *required* `Unsupported` field removes `create`, `createMany`
  and `upsert` from the generated delegate entirely, which was verified against
  the installed Prisma 7.9.1.
- 2026-08-23: `@@index([embedding])` is not a workaround. Prisma accepts it and
  it applies, but it produces a plain btree, which cannot serve
  `ORDER BY embedding <=> $1` — roughly 6 KB per row of index for no benefit.
- 2026-08-23: PR4 will read and write vectors through `$queryRaw`, not
  TypedSQL. `prisma generate --sql` requires a reachable database at generate
  time, and this repository commits the generated client and fails CI on drift
  — adopting TypedSQL would make the drift check depend on a live pgvector
  PostgreSQL.
- 2026-08-23: Moving to `pgvector/pgvector:pg16` is a Debian image where the
  current one is Alpine, and there is no Alpine variant. The data directory is
  binary-compatible for the same PostgreSQL major, but musl and glibc sort text
  differently under the same locale name, and musl records no collation version
  — so PostgreSQL emits no mismatch warning and every text btree index is
  silently left in the wrong order. `REINDEX DATABASE` followed by
  `ALTER DATABASE ... REFRESH COLLATION VERSION` is therefore a mandatory
  operator step on the existing Staging volume, and a deployment prerequisite
  recorded for the human who merges this stack. The application does not and
  must not perform it.

- 2026-08-23: PR3 found and repaired a defect that predated it: `apiRequest`
  never unwrapped the backend's `{ success, data, meta }` envelope. Every
  caller that existed before the control plane returns `void`, so no body had
  ever been read and the omission was invisible. The pre-existing test asserted
  against a bare array — a response the global `ResponseInterceptor` cannot
  produce — and so pinned the defect rather than catching it.
- 2026-08-23: PR4 denormalizes `organizationId` onto all three knowledge
  tables, and `spaceId` onto chunks, rather than deriving either through a
  parent. The scoping predicate has to sit in the same row as the vector so the
  ranking query can be scoped without a join; a join is a thing a later query
  can omit, and omitting this one returns another organization's material.
- 2026-08-23: `EmbeddingPort` is declared in PR4 and left unbound. Nothing in
  this increment turns text into a vector — the provider adapter arrives with
  the ingestion pipeline that needs it — and binding a placeholder would put a
  fake in production wiring.
- 2026-08-23: Retrieval takes a vector, not text. The thing that embeds is the
  pipeline, and a retrieval service that embedded on the caller's behalf would
  make the core depend on a provider it does not need.
- 2026-08-23: The operator ceiling `knowledge.retrieval_max_chunks` clamps the
  caller's requested limit rather than defaulting it. How much context a run
  may pull is a cost decision belonging to whoever pays the provider bill, and
  a limit a caller can exceed is advisory.
- 2026-08-23: An empty granted-space list retrieves nothing rather than
  everything, and is refused before a query is built. "No spaces declared" must
  never widen to "all spaces", which is what dropping an empty `IN` clause
  would do.
- 2026-08-23: The knowledge isolation suite is an e2e against real pgvector,
  not a unit test with a double. A fake repository can show that an
  organization id is passed along; it cannot show that the id *scopes*
  anything. The fixtures make the other tenant's chunk a strictly closer match
  than the querying tenant's, so an unscoped or post-filtered query returns the
  wrong row first rather than passing by luck.

- 2026-08-23: PR4 review repaired five findings and accepted one deferral.
  - A non-integer retrieval limit is refused rather than clamped.
    `Math.min(NaN, ceiling)` is `NaN`, the driver binds `NaN` and `Infinity` as
    SQL `NULL`, and `LIMIT NULL` means *no limit* — verified against the test
    database — so the operator ceiling was bypassable by the value an HTTP
    handler produces for any non-numeric query string. Checked in the service
    and again at the SQL boundary.
  - A zero-norm embedding is refused. pgvector answers `NaN` for cosine
    distance rather than raising, PostgreSQL sorts `NaN` last instead of
    erroring, and every threshold a caller applies against it is false — so a
    search would report that nothing is relevant, silently.
  - The score range was documented as `[0, 1]` and is `[-1, 1]`. `<=>` is
    distance over `[0, 2]`, and real models produce negative similarity for
    opposed text. Corrected rather than clamped: clamping would erase the
    difference between unrelated and opposite.
  - `embeddingModel` is now a predicate rather than a note. The schema claimed
    recording it made a model migration detectable; nothing detected anything.
    A query states the model it was embedded with and ranks within it, which
    matters because 1536 dimensions was chosen precisely so a model swap is
    *not* forced through a migration that stops traffic — the table holds both
    during re-embedding.
  - The tenant column is now enforced by composite foreign keys rather than
    maintained by convention. `knowledge_chunk.organizationId` is the entire
    scoping predicate, and three independent single-column references left the
    row's three tenant answers agreeing only as far as whatever wrote it was
    correct. Done now because the tables are empty and it is additive.
  - Deferred: retrieval does not check `knowledge.enabled`. The flag's promise
    is that disabling refuses *new* work; an accepted run must still complete,
    so the gate belongs at the acceptance boundary in PR5 and PR6, not inside
    the retrieval a running agent performs. No `assertFeature` caller exists
    anywhere yet.

- 2026-08-23: The committed Prisma client embeds the schema *text* as
  `inlineSchema`, so editing a `///` doc comment after the last
  `prisma generate` is drift and fails CI on its own. Regenerate after any
  schema edit, comments included — not only after a field or model change.

- 2026-08-23: PR5 authorizes in a guard rather than with `@MemberHasPermission`
  or a check inside the handler. Two reasons, and the second was found by a
  failing test. `@MemberHasPermission` authorizes against the session's *active*
  organization, while these routes name their organization in the path, so an
  operator who had not switched into it would be refused work they may do — and
  worse, one who *had* switched into a different organization would be granted a
  check against the wrong tenant. Checking inside the handler was tried first and
  returned 400 where 404 was expected: Nest runs guards before pipes, so body
  validation ran ahead of authorization and told an unauthorized caller the
  request shape. The guard restores the ordering.

- 2026-08-23: Ingestion is content-addressed on `(organizationId, spaceId,
  title)` with a checksum, rather than keyed on a caller-supplied id. Re-sending
  identical text is recognized and does nothing at all — no revision, no chunk
  rewrite, no outbox event — because embedding is the expensive step and the
  common case for a management surface is re-saving unchanged material.

- 2026-08-23: The outbox dedupe key is `${documentId}:${revision}`, not the
  document id. Found by mutation: keying on the document alone left the test
  suite green, but the key becomes BullMQ's job id, so a second edit would be
  discarded as a repeat while retention still held the first job — leaving the
  new revision's chunks silently unembedded. A regression test now pins it.

- 2026-08-23: There is no revision *history* table. `revision` counts changes so
  deliveries can be distinguished; nothing in this milestone reads an older
  revision, and a table only ever written is a table that drifts.

- 2026-08-23: The embedding model is a code constant, not a runtime setting. The
  stored vectors' dimension depends on it, so an operator changing it in the
  Platform would not reconfigure the system — it would silently split the corpus
  into two incomparable halves. Changing models is a re-embedding, and the
  `embeddingModel` predicate is what makes that possible without downtime.

- 2026-08-23: Three pre-existing tests failed once PR5 added a second routed
  event type and a member grant, and all three were repaired to derive from the
  system rather than restate it: the dispatcher test now asserts the claim
  against `ROUTABLE_EVENT_TYPES`, and the member test states an allow-list
  instead of "nothing". Restating a set that grows is how a test goes stale
  without going red.

- 2026-08-23: The outbox e2e suite now clears its table *before* each test as
  well as after. Its comment claimed nothing else wrote there; knowledge
  ingestion now does, and a claim asks for every routable type, so rows left by
  an earlier suite were leased alongside the test's own. This is also the most
  likely explanation for the single unexplained e2e failure recorded during PR3
  — it was cross-suite pollution, not flake.

- 2026-08-23: The Platform document list is tagged with the space it was loaded
  for. Found while repairing a `react-hooks/set-state-in-effect` violation: the
  effect cleared the list by writing state, and removing that write exposed that
  an untagged list renders whichever of the two arrived last — showing one
  space's documents beneath another's heading.

- 2026-08-23: PR5 review found one high finding — a document whose embedding
  job exhausted its attempts could never be embedded again. The natural
  first-use order (enable the feature, store a document, then configure the
  provider credential) fails every attempt; re-submitting the text is what an
  operator will try, and content addressing recognized it as unchanged and
  wrote nothing. Nothing swept for chunks still owed a vector. The unchanged
  path now re-requests embedding when any chunk lacks a vector for the current
  model, deliberately with *no* dedupe key: the key is BullMQ's job id and the
  failed job is retained, so a repair carrying it would be discarded as the
  duplicate it is not. The same path is what makes a model change a re-run.

- 2026-08-23: Embedding is paged rather than done in one call. A provider
  failure on the last batch of a long document threw away every vector the
  earlier batches had been billed for, and the retry bought them again — the
  handler's own idempotence comment was only true of its writes. The port now
  states its batch size and the handler reads, embeds, and writes one page at
  a time, so progress is durable and resident memory is one batch.

- 2026-08-23: `knowledge.ingestion_max_document_bytes` was unreachable. The
  application parses JSON with a 1 MiB body limit, while the setting allowed
  10 MiB and defaulted to exactly 1,048,576 — over the limit once the envelope
  is counted. Raising it would have changed nothing observable and the request
  would have failed with a bare 413. The ceiling is now 512 KiB with a 256 KiB
  default, under the transport with headroom for JSON escaping. Raising the
  global body limit was rejected: it applies to every endpoint.

- 2026-08-23: The archive check ran before the membership check, which turned
  the pair into a confirmation oracle — `ORGANIZATION_ARCHIVED` is a 403 with
  its own code while every other refusal is a 404, so a stranger who guessed an
  id learned it named a real organization. Membership is decided first now.
  Note the same order exists in `auth-hooks.ts`, which is safe because Better
  Auth resolves membership before it runs; this guard had no such protection.

- 2026-08-23: Deletion is deliberately outside `knowledge.enabled`. The flag
  refuses new work, and an operator switching knowledge off is the likeliest
  person to want the material gone. Documented on both `remove` methods and
  pinned by a test, rather than left for the next reader to infer.

- 2026-08-23: Ingestion is metered at 60 per five minutes per user. A per-minute
  cap tight enough to matter refuses the one thing people legitimately do —
  seeding a knowledge base is dozens of documents in a row — so the window
  absorbs the burst while holding the sustained rate far below the generic
  budget. Discovered by the e2e suite failing with 429 under a first attempt at
  12 per minute, which was the right signal about real usage.

- 2026-08-23: Two listings had no tenant-predicate coverage, the only knowledge
  paths without a negative cross-organization test. Every other case is a
  refusal, which is loud; a listing that loses its predicate answers 200 with
  another organization's rows, which looks like working software. Both are now
  pinned and both mutants were killed.

- 2026-08-23: Nothing joined the outbox route table to the handlers that answer
  it — two unrelated literals. A queue or job name changed on one side left
  every test green while production published jobs nobody consumed, which does
  not fail but stalls and retries forever. `worker-composition.spec.ts` now
  asserts a registered handler for every routable event type.

- 2026-08-23: Superseded by the hardening remediation. Knowledge listings now
  use a bounded, stable cursor scoped to both organization and canonical space;
  the Platform consumes later pages. Cursor misuse across either scope is a
  refusal and cannot change the query predicate. The permission-catalog note
  remains historical and does not affect that pagination contract.

- 2026-08-23: One surviving mutant, recorded rather than papered over. The
  embedding handler's page cursor is `ordinal > after`; changing it to `>=`
  survives, because the pending predicate already excludes rows a write has
  cleared. The cursor is a termination guard against a state the writes make
  unreachable, so no honest test exercises it, and inventing one would assert
  a scenario that cannot occur.

- 2026-08-24: PR6 generalized PR5's knowledge guard rather than writing a second
  one. Duplicating it would have meant two copies of the membership check, the
  archive ordering and the fail-closed default — the three decisions in this
  repository that are least safe to have two versions of. The cost is that PR6
  touches PR5 files, which is the honest trade.

- 2026-08-24: `agents.enabled` gated nothing. The flag has existed since the
  control plane landed, described to operators as "accept new agent runs", and
  no production code read it — harmless while no feature spent money through
  that path, and exactly wrong now that one does. Acceptance checks it before
  the per-feature flag, so the coarse switch is the coarse switch. Found by
  review against this plan's own acceptance criteria, which name both flags.

- 2026-08-24: Superseded by the hardening remediation. The organization run
  ceiling is exact: acceptance takes a transaction-scoped PostgreSQL advisory
  lock keyed by organization around the repeated idempotency check, in-flight
  count, run creation, and outbox intent. Different organizations do not block
  each other, and an accepted idempotent retry wins before capacity refusal.
  The per-user rate limit remains independent of that durable spend control.

- 2026-08-24: The generation call is now bounded. Everything entering a prompt
  was capped and nothing capped what came back, though tokens are billed before
  the output schema can reject them. An output-token ceiling, a wall-clock
  timeout so a stalled provider does not hold a worker slot until BullMQ
  reclaims the job, and `maxRetries: 0` — retry belongs to BullMQ, which
  records each attempt against the run, rather than to an SDK loop that spends
  three calls and reports one. One set of numbers for one agent; a second
  definition needing different ones makes this a field on `AgentDefinition`.

- 2026-08-24: The passage fence escapes its own closing tags. A document
  containing `</passage></reference>` could end the quoted block and continue
  where the preamble tells the model the caller's request appears. The blast
  radius today is one tenant's own bad answer, since this agent has no tools —
  but that argument expires the moment it gains one, and by then nobody would
  remember the fence was decorative. Angle brackets are replaced rather than
  the tag names, so the text still reads as itself.

- 2026-08-24: `isKnownProvider` used `in`, so `'toString' in PROVIDER_SECRETS`
  answered true and a definition reading `toString/x` would have passed an
  inherited function into the secret lookup. Not attacker-reachable — models
  come only from code-owned definitions — and safe when it happened, but it
  turned a deterministic configuration mistake into three retried runtime
  failures. `Object.hasOwn` now.

- 2026-08-24: The context assembler went through `KnowledgeSpaceService`
  instead of `prisma` directly. `resolveSlugs` had been written in PR4 for
  exactly this caller and then reimplemented inline, which left the knowledge
  module's deliberate withholding of storage access crossed in one place and a
  dead method beside it. It now returns the slug as well as the id, because the
  caller labels each passage with the space it came from.

- 2026-08-24: Two joins between unrelated literals are now asserted. Nothing
  checked that `PRODUCTION_AGENT_DEFINITIONS` contains the `(id, version)` pair
  the API pins onto every run it accepts, so dropping the definition or bumping
  the constant would have left acceptance answering `202` and every run failing
  in the worker as an unregistered pair. Nothing checked that a registered
  definition names a provider this build can authenticate either. Both are
  asserted where `WorkerModule` is already booted.

- 2026-08-24: The "API cannot execute agents" assertion was depth-one, reading
  `AppModule`'s own import list, and PR6 adds the feature module that would
  want a runner. Adding `AgentExecutionModule` to `ContentIdeaModule` passed
  every check in the suite. The boundary is now asserted over the transitive
  import closure and over the provider set that closure declares.

- 2026-08-24: The content-ideas e2e suite holds organization overrides rather
  than a platform override. `control-plane.e2e-spec.ts` counts that table with
  no predicate and clears it unscoped, precisely so an interrupted run cannot
  leave a flag on for the next suite, so isolation is a property of the rows
  rather than of `maxWorkers: 1` and an `afterAll` that ran. The suite also
  deletes the outbox rows its runs committed, matching the three neighbouring
  agent suites; leaving them accumulated PENDING dispatch intents pointing at
  deleted rows. That omission is what produced the outbox batch-limit failure
  in the first full e2e run, which is the same shape as the flake recorded
  against PR3.

- 2026-08-24: The evaluation fixtures were trimmed rather than grown. Rows
  asserting that `.min(3)` refuses a two-character topic restate the line above
  them and would have to be edited in lockstep with it forever, which makes
  them a second copy of the schema. What was actually missing was a test that
  `AgentRunner` applies the schema at all — the decision the file's own header
  claimed to stand in for — along with the retry classification on either side
  of it. Five mutants against those paths, all killed, including the one that
  returns the provider's payload instead of the schema's product.

- 2026-08-24: PR7's polling stops only when the server has answered about the
  operation — 401, 403, 404. The first version stopped on any refusal, which
  reads as caution and is the opposite. The read shares the route's own
  rate-limit budget, so a second tab watching one run exhausts it; treating that
  429 as a refusal ended the watch on a run that was still executing and then
  showed copy inviting the resubmission that pays for a second one. A 5xx is an
  instance being rolled. Both are ridden out now, with the give-up timeout as
  the backstop, because reporting a run as still running is true and a wrong
  refusal is not.

- 2026-08-24: A new submission drops the operation it supersedes. Not tidiness:
  clearing the stopped flag restarts the poll, and while the request is in
  flight the only operation to poll is the previous one — whose read may fail
  again and stop the watch a second time, so the run being asked for arrives
  already-stopped and is never watched. Billed, executed, never shown. Found by
  review, not by a test, and now pinned by one.

- 2026-08-24: The idempotency key survives a 5xx and a 408, not only a
  transport failure. The first version's comment claimed any answer from the
  server meant the submission was decided, which is true of 4xx and false of a
  gateway timeout: acceptance commits the run and its outbox event in one
  transaction, so a proxy giving up after that commit reports failure for work
  that will be billed. Keeping the key is safe either way — it finds the run if
  there is one and creates it once if there is not.

- 2026-08-24: The give-up screen was dead code. `gaveUp && isPending` cannot be
  satisfied, because `isPending` already requires `!gaveUp`, so an abandoned run
  showed its last-seen status — "Queued" — and the copy written for it was
  unreachable. The flag also conflated two situations wanting different screens:
  waiting too long leaves a run worth resuming, while a refusal means the server
  will not answer about it again and offering to keep waiting is a button that
  cannot work. It is a reason now, and the timeout is a parameter so the screen
  is reachable from a test at all.

- 2026-08-24: Copy that promised what the feature does not do. "Reopening this
  tab will pick it up" was false — the operation id lives only in component
  state, there is no URL parameter and no list endpoint to recover it from — and
  "You will see the results here" was false for a reader who cannot submit, for
  the same reason. Both corrected in English and Arabic, and the code comment
  and `docs/frontend.md` corrected with them rather than left contradicting the
  screen.

- 2026-08-24: The form enforces the schema's upper bounds itself. A 400 from
  this endpoint is a dead end for the operator: the global validation pipe
  answers with a field-error array, which this application's error reader does
  not accept, so the screen can only say the request was refused without naming
  the field or the limit. Teaching the shared client a third details shape for a
  case a form should not produce was rejected; `maxLength` plus the bounds in
  the submit gate makes it unreachable instead.

- 2026-08-24: The failure taxonomy moved out of the component, following
  `invitation-state.ts` and `organization-errors.ts`. Exporting a constant from
  a component file is a fast-refresh warning `pnpm lint` catches, and the move
  turned `classify` and the two retry predicates into pure functions worth
  testing directly — which is where the 401 branch and the catch-all are
  covered, since neither is reachable by clicking. Five mutants against them,
  all killed.

- 2026-08-24: Fake timers are unusable in this Platform suite. `userEvent`
  awaits a real delay a faked clock never reaches, so every interaction hangs —
  confirmed with an isolated reproduction rather than assumed. The poll interval
  and the give-up timeout are therefore parameters defaulting to the product
  values, and the default cadence has an assertion of its own so the one number
  no injected test touches is not the one that silently changes.

- 2026-08-24: One surviving mutant, recorded rather than papered over. The
  poll's monotonic guard — refusing to write a non-terminal status over a
  terminal one — cannot be reached by a test: storing a terminal status tears
  the effect down and its `current` flag already blocks anything that lands
  afterwards. The window it closes is between that store and React running the
  cleanup, and no test opens it deterministically. Kept, because losing it costs
  a flicker and a reset deadline, and documented as belt and braces.

- 2026-08-24: Superseded by the hardening remediation. A minimal Chromium
  Playwright smoke harness now exercises the real Platform route against a
  deterministic API boundary: final form fields and idempotency header,
  queued-to-succeeded rendering, URL operation recovery after reload,
  proactively disabled availability, and resilient polling through transient
  429/5xx responses. The browser tests run in CI. Operation identity lives in
  URL state and ambiguous submissions preserve their idempotency identity in
  session storage, so reload no longer loses a paid operation.

## Hardening remediation

The incremental remediation finalizes the unmerged `content-idea@1` contract
and closes the operating gaps found across PR30–PR36. The request has `topic`,
`goal`, `language`, optional `audience`/`guidance`, and `numberOfIdeas`; its
strict output is parsed before durable success, and the requested
`numberOfIdeas` is enforced exactly as a declared output contract on the same
path — a wrong count is a retryable provider-output failure. Knowledge spaces are a
code-owned eight-space registry, while the agent's context policy is exactly
`organization.profile`, `brand.voice`, `audience`, and `content.strategy`
within 12 chunks and 12,000 characters. The deterministic evaluation fixture
exercises application behavior and isolation, not subjective model quality.

Control-plane mutations now append a safe, atomically written audit event that
survives reset/deletion. Audit values are sensitivity-aware projections and
never contain credential material. PostgreSQL also enforces the last usable
super-admin floor and serializes exact per-organization run acceptance. The
knowledge ingestion path returns the committed `updatedAt` after a source-URI
only update without rewriting chunks or incrementing revision. The Platform
adds audit history, canonical-space selection, cursor pagination, availability
readiness, reloadable operation state, and browser smoke coverage. The audit
tab renders only a closed safe projection and is regression-tested against
hostile `before`/`after` payloads carrying a secret canary. The reloadable
submission identity in session storage keeps an idempotency key beside a
SHA-256 digest of the canonical request, never the request text.

## Outcome

All seven pull requests and the hardening remediation landed on `main` at
`b50b0f7`, and the merged release is deployed to Staging. The plan is complete;
what it did not cover is the host side of delivery.

Bringing the release up on Staging required four manual repairs that CI could
not have caught, because none of them are properties of the repository:

- the installed `/opt/ai-agent/docker-compose.yml` still pinned stock
  PostgreSQL, so `CREATE EXTENSION vector` failed inside the migration
  container after the release had already been pulled;
- the PostgreSQL image had to be moved to `pgvector/pgvector:pg16` and the
  Prisma migration state recovered by hand;
- `APP_ENCRYPTION_KEY` was absent from `/etc/ai-agent/runtime.env`, so the
  backend refused to boot after migrations had run;
- `/usr/local/sbin/ai-agent-deploy` on the host predated the release it was
  deploying.

Every one of those is the same defect: the host bundle is unversioned, so a
release cannot state which host it requires and the host cannot refuse a
release it cannot run. `docs/exec-plans/active/host-bundle-versioning.md`
carries that work.

## Blockers

None currently.
