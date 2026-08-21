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
job id is only short-lived transport deduplication. Organization and creator
foreign keys restrict deletion so execution history cannot be silently removed.

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
