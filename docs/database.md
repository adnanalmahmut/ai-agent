# Database

PostgreSQL stores identity, sessions, accounts, verification records,
organizations, members, invitations, Better Auth rate-limit rows, agent runs,
outbox events, control-plane state, organization product-audit history, and
organization knowledge. Prisma schema and generated client are committed and
CI verifies that generation is current.

The `organization` row also owns application business settings separately from
Better Auth's profile fields: `locale`, `timezone`, `currency`, `legalName`,
`industry`, `websiteUrl`, and `businessDescription`. The defaults (`ar`, `UTC`,
and `USD`) make every existing row immediately readable. The schema stores a
dedicated `businessProfileVersion` and `businessProfileUpdatedAt`; application
writes compare and increment that version so Better Auth name/slug changes do
not cause false conflicts. These are typed columns rather than entries in the
legacy metadata string because they are stable product inputs with one owner,
validation contract, and future consumers.

`organization_audit_event` is append-only product history rooted in a required
organization foreign key. It records the authenticated actor when one exists,
an application-owned action and subject identity, commit time, and closed safe
JSON projections before and after a mutation. `actorUserId` is intentionally
not a foreign key: an audit fact must survive a future actor-lifecycle change
without blocking it or erasing attribution through `SET NULL`. Organization
deletion is restricted so tenant history cannot be orphaned or silently
removed. Reads are served by `(organizationId, occurredAt, id)` descending;
the second index supports the history of one subject without weakening the
tenant predicate. The application exposes create-in-transaction and bounded
list operations only—no update or delete operation.

`agent_run` is the durable business authority for accepted background agent
work. Its lifecycle is deliberately small (`QUEUED`, `RUNNING`, `SUCCEEDED`,
`FAILED`) and separate from outbox delivery and BullMQ job state. Runtime is a
string because application code owns runtime support; adding a runtime does not
inherently require a database enum migration. Request idempotency is enforced
by `UNIQUE (organizationId, idempotencyKey)`, while the run id used as BullMQ's
job id is only short-lived transport deduplication. The organization foreign key
restricts deletion so execution history cannot be silently removed, and the
creator foreign key does the same when a creator is present.

`agentVersion` pins the run to one definition revision. Definitions are code,
so `agentId` alone is ambiguous the moment a definition changes: a run accepted
before a deployment must still execute the revision it was accepted against.
The pair `(agentId, agentVersion)` is therefore what a worker resolves.

`createdByUserId` is nullable. Null means only that no authenticated
application User initiated the run, which is the honest representation for
scheduled or system-initiated work. It is not an actor abstraction, a trigger
hierarchy, or a placeholder for a synthetic system user.

A run can also be finalized by the worker's reconciliation sweep rather than by
the attempt that was executing it. When BullMQ terminally fails a job without
invoking the handler, no attempt is left to record an outcome, so the sweep
writes `FAILED` with `completedAt` and an application-owned constant. That
write is conditional on the run still being `QUEUED` or `RUNNING`, which is what
makes a repeated, delayed, or reordered observation a no-op and keeps a run that
a late worker managed to complete from being dragged back to failed. It
deliberately does not match on `attemptCount`: the sweep is not an attempt, and
forging an ordinal would be wrong precisely in the skipped-ordinal case the
fence exists for.

`INDEX (status, updatedAt)` serves that sweep, which repeatedly asks for the
oldest non-terminal runs. Terminal rows are never deleted, so without the index
a bounded query costs a scan proportional to total history rather than to the
backlog it is looking for: measured on PostgreSQL 16 against 200,000 terminal
rows and a 200-row live tail, the query plans as a bitmap index scan over three
heap blocks at 0.5 ms, against 58 ms for the sequential scan the planner chooses
without it. The index carries no durable state and no semantics, and
correctness does not depend on it.

Migration order:

1. Better Auth core.
2. Admin, organization, and reversible lifecycle fields.
3. Transactional outbox.
4. Nullable session country/city.
5. Better Auth database rate-limit storage.
6. Durable agent-run foundation.
7. Agent-run reconciliation index.
8. Control plane: feature-flag overrides, runtime settings, managed secrets.
9. Knowledge storage and management.
10. Control-plane audit history and the super-admin floor.
11. Additive organization business settings.

Feature-flag overrides are two tables — one platform-wide, one per
organization — rather than one table with a nullable `organizationId`.
PostgreSQL treats NULLs as distinct in a unique index, so "at most one platform
override per key" would not actually hold on the single-table shape, and the
constraint that matters most would have been the one silently missing. The
organization table cascades on organization delete, because an override for an
organization that no longer exists has no meaning. Every control-plane table
nulls its editor on user delete: who changed a setting is useful history but
must never block removing an account.

Managed secrets store ciphertext, nonce and authentication tag as separate
`Bytea` columns alongside the algorithm and a fingerprint of the master key that
sealed them. The fingerprint is what lets the application distinguish "encrypted
under a key this deployment no longer has" from "this row was altered" — GCM
alone reports both as an authentication failure.

Sessions/accounts cascade with their user because they have no independent
historical meaning. Membership and invitation foreign keys restrict deletion
because they carry history. User/organization roots are changed through soft
lifecycle fields, not physical deletion.

Deployments run `prisma migrate deploy` before application rollout. Migration
failure stops deployment. Schema evolution must remain backward compatible via
expand → migrate/backfill → switch → contract-later; rollback never executes a
down migration. See [backup/restore](backup-restore.md) for recovery.

## Knowledge

`knowledge_space`, `knowledge_document`, and `knowledge_chunk` hold
organization-owned reference material, chunked and embedded so an agent can be
given the parts of it that bear on a request. A space is a named collection
within one organization, unique by `(organizationId, slug)`, because an agent's
context policy names the spaces it may read by slug and a slug stays readable
in code review where a per-deployment uuid would not.

All three tables carry `organizationId`, including the two that could derive it
through a parent. That denormalization is the isolation mechanism: the tenant
predicate has to sit in the same row as the vector so the ranking query can be
scoped without a join, and a join is something a later query can omit. Omitting
it here returns another organization's material. `knowledge_chunk` carries
`spaceId` for the same reason — a context policy is enforced by the same
predicate that ranks.

A document is identified within its space by title —
`@@unique([organizationId, spaceId, title])` — because ingestion is an upsert
on the material's own name rather than on an id the caller would have to keep.
`revision` counts how many times that title's content has actually changed;
there is deliberately no revision *history* table, since nothing in this
milestone reads an older revision and a table that is only ever written is a
table that will drift.

Organization deletion is restricted on all three, like every other business
table. Documents and chunks cascade from their space, and chunks from their
document, because neither has meaning without its parent and re-ingestion
replaces them wholesale.

The tenant column is enforced, not merely maintained. `KnowledgeSpace` and
`KnowledgeDocument` carry `@@unique([id, organizationId])` so a child can
reference the pair, and `KnowledgeChunk` references
`(spaceId, organizationId)` and `(documentId, organizationId)` rather than the
two ids alone. Left as independent single-column keys, the three tenant answers
on one row would agree only as far as whatever wrote it was correct — and
`organizationId` is the entire scoping predicate. As pairs, a chunk claiming one
organization while sitting in another's space is a constraint violation.

`knowledge_chunk.embedding` is `vector(1536)`, provided by the `vector`
extension that the migration creates. 1536 is `text-embedding-3-small` native
and reachable by `text-embedding-3-large` through its `dimensions` parameter,
so two further models remain available without a table rewrite and a full
re-embedding. The column is nullable, and not only because a chunk exists
before it is embedded: a *required* `Unsupported` field removes `create`,
`createMany` and `upsert` from the generated Prisma delegate entirely. Vectors
are therefore written by a raw `UPDATE` after the row exists, and a chunk whose
embedding is still null is excluded from retrieval rather than treated as a
zero vector — which would be an equidistant match to everything.

`embeddingModel` records which model produced each vector, and retrieval
filters on it. Two models' embeddings are not comparable, and 1536 dimensions
was chosen precisely so one model can replace another without a column change —
which means the swap is not forced through a migration that stops traffic and
the table holds both during re-embedding. A query that ranked across them would
be confidently wrong with no error, so a search states the model it was
embedded with and sees only rows from that model.

There is deliberately **no vector index**. An approximate index applies the
tenant predicate after the index scan, so a scoped query returns whichever of
the requested rows happen to survive the filter — short, with no error. Prisma
also cannot represent HNSW or IVFFlat and emits `DROP INDEX` for one on every
subsequent migration, including an index created by raw SQL inside a migration
file, so it would not survive a forward-only pipeline in any case. Exact search
needs no index. The btree on `(organizationId, spaceId)` is what serves the
scoping predicate, which is what pgvector's own guidance recommends for a
filter this selective. Introducing an approximate index is a decision for
measured evidence, not for anticipation.

Vector reads and writes go through `$queryRaw`/`$executeRaw` rather than
TypedSQL. `prisma generate --sql` requires a reachable database at generation
time, and this repository commits the generated client and fails CI on drift —
adopting it would put a pgvector-capable PostgreSQL into the client-generation
step to type two queries.
