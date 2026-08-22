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
a bounded query would cost a full scan proportional to total history rather than
to the backlog it is looking for. It carries no durable state and no semantics.

Migration order:

1. Better Auth core.
2. Admin, organization, and reversible lifecycle fields.
3. Transactional outbox.
4. Nullable session country/city.
5. Better Auth database rate-limit storage.
6. Durable agent-run foundation.
7. Agent-run reconciliation index.

Sessions/accounts cascade with their user because they have no independent
historical meaning. Membership and invitation foreign keys restrict deletion
because they carry history. User/organization roots are changed through soft
lifecycle fields, not physical deletion.

Deployments run `prisma migrate deploy` before application rollout. Migration
failure stops deployment. Schema evolution must remain backward compatible via
expand → migrate/backfill → switch → contract-later; rollback never executes a
down migration. See [backup/restore](backup-restore.md) for recovery.