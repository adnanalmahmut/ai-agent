# Database

PostgreSQL is the authority for identity, tenant data, configuration, accepted
agent work, approvals, and audit history. The Prisma schema is
`apps/backend/prisma/schema.prisma`; generated client code is committed and CI
checks that it is current.

## Model groups

| Area           | Models                                                                              |
| -------------- | ----------------------------------------------------------------------------------- |
| Authentication | `User`, `Session`, `Account`, `Verification`, `RateLimit`                           |
| Organizations  | `Organization`, `Member`, `Invitation`, `OrganizationAuditEvent`                    |
| Agents         | `AgentRun`, `OrganizationAgentInstallation`, `OrganizationAgentVersion`             |
| Tools          | `ToolExecution`, `ToolExecutionApproval`                                            |
| Delivery       | `OutboxEvent`                                                                       |
| Control plane  | feature-flag overrides, `RuntimeSetting`, `ManagedSecret`, `ControlPlaneAuditEvent` |
| Knowledge      | `KnowledgeSpace`, `KnowledgeDocument`, `KnowledgeChunk`                             |
| Content        | `ContentProject`, `ContentDraft`                                                    |

Agent definitions, model definitions, tool definitions, and runtime adapters are
code-owned. Database rows reference their stable/versioned identities; they do
not redefine executable behavior.

## Isolation and integrity

Organization-owned relationships include `organizationId` even where it could
be inferred through a parent. Composite foreign keys bind child and parent
tenant identity so a service predicate is not the only defense against
cross-organization references.

Identity and organization roots use reversible lifecycle state. Historical
membership, agent, content, tool, and audit rows use restrictive relations
rather than cascading deletion. Sessions and provider account links cascade
with their user because they have no independent historical value.

Durable idempotency is enforced with PostgreSQL uniqueness and conditional
writes. Examples include organization-scoped request keys, immutable
organization-agent version numbers, tenant-safe source-run references, and
single approval decisions. BullMQ job IDs improve efficiency but do not replace
these constraints.

Audit tables are append-only from the application's perspective. Product
mutations write their audit row in the same transaction. Managed-secret values
are authenticated ciphertext; read models expose metadata only.

Knowledge chunks repeat organization and space identity so tenant filtering is
inside the vector-ranking query. The composite relation prevents a chunk from
claiming a different organization than its space. The vector field is managed
with pgvector and queried through the knowledge repository.

## Agent-run lifecycle

`AgentRun` is distinct from both outbox delivery state and BullMQ job state. A
run pins the exact agent revision, organization-agent version, model policy,
model, and price revision selected at acceptance. The queue payload contains
only the run ID.

Attempt ordinals act as fencing tokens. Terminal writes match the current claim
so a delayed worker cannot overwrite a newer attempt. Safe, bounded constants
are the only permitted persisted failure diagnostics.

## Migrations

Migrations are forward-only and run as a separate deployment mode before
application replacement. Schema changes must remain compatible with the
currently running image through an expand/migrate/switch/contract sequence.

Useful commands:

```sh
pnpm db:generate
pnpm db:validate
pnpm db:migrate       # create and apply a development migration
pnpm db:deploy        # apply committed migrations
```

Do not use `db:push` for shared schema changes. See [deployment](deployment.md)
for the migration gate and [backup/restore](backup-restore.md) before recovery
work.
