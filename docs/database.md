# Database

PostgreSQL stores identity, sessions, accounts, verification records,
organizations, members, invitations, Better Auth rate-limit rows, agent runs,
and outbox events. Prisma schema and generated client are committed and CI
verifies that generation is current.

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

The AgentRun migration is still unmerged and was corrected in place rather than
by a follow-up migration. A database that applied its earlier form keeps the old
table: Prisma reports the schema up to date and `migrate deploy` re-applies
nothing, because a changed checksum on an applied migration raises no drift
signal. Deployed environments are unaffected — this migration has never been
applied to one, and CI builds a fresh database per run — but a local database
that applied the earlier form must be reset with
`pnpm --filter backend db:reset`.

Migration order:

1. Better Auth core.
2. Admin, organization, and reversible lifecycle fields.
3. Transactional outbox.
4. Nullable session country/city.
5. Better Auth database rate-limit storage.
6. Durable agent-run foundation.

Sessions/accounts cascade with their user because they have no independent
historical meaning. Membership and invitation foreign keys restrict deletion
because they carry history. User/organization roots are changed through soft
lifecycle fields, not physical deletion.

Deployments run `prisma migrate deploy` before application rollout. Migration
failure stops deployment. Schema evolution must remain backward compatible via
expand → migrate/backfill → switch → contract-later; rollback never executes a
down migration. See [backup/restore](backup-restore.md) for recovery.
