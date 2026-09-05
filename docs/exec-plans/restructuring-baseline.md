# Restructuring migration baseline

Working document for the restructuring. It records what exists today, where
each responsibility is expected to land, and which guarantees must survive the
move. The agreed destination is [ADR 0002](../decisions/0002-target-service-decomposition.md);
this file does not restate it.

Every current-state claim below names the file that proves it. Nothing here
changes runtime behavior, and nothing here creates the target structure.

Baseline commit: `c03a3ad6d65477932827f7265cfda7da9c0b6aaa`.

## Current inventory

### Workspaces and composition roots

`pnpm-workspace.yaml` covers `apps/*` and `packages/*`: `apps/backend`,
`apps/platform`, `apps/web`, and `packages/authz-policy`, `packages/i18n-core`,
`packages/ui`.

One NestJS source tree has three composition roots, each with its own start
script in `apps/backend/package.json`:

| Root    | Entry                              | Script                     |
| ------- | ---------------------------------- | -------------------------- |
| API     | `apps/backend/src/api/main.ts`     | `start:prod`               |
| Worker  | `apps/backend/src/workers/main.ts` | `worker:prod`              |
| CLI     | `apps/backend/src/cli/main.ts`     | `cli`                      |

CLI commands live in `apps/backend/src/cli/` — super-admin bootstrap
(`super-admin.command.ts`, `super-admin.bootstrap.ts`), admin user
administration (`admin-user-api.ts`), and encryption key rotation
(`rotate-key.command.ts`), dispatched by `dispatch.ts`.

### Frontend surfaces

`apps/web` serves the public site and holds one route,
`apps/web/src/app/[locale]/page.tsx`.

`apps/platform` holds every authenticated screen in a single app: guest
authentication under `(auth)`, organization product screens under
`(platform)/organizations/[organizationId]/…` (approvals, content ideas,
content projects, invitations, knowledge, members, settings), and platform
administration under `(platform)/admin/…` (`control-plane`, `users`).

The customer and platform-administration split named in ADR 0002 does not exist
yet: both live in the same `(platform)` route group.

### HTTP surface

Controllers, from `@Controller` declarations under `apps/backend/src`:

- Organization-scoped: `organizations/:organizationId/` +
  `agent-action-approvals`, `mcp-sessions`, `agent-installations`,
  `content-ideas`, `content-projects`, `knowledge`, `audit-events`,
  `business-profile`
- Platform-scoped: `platform/control-plane`
- Account and lifecycle: `admin/users`, `user/account`, `organizations`
  (`infrastructure/auth/lifecycle.controller.ts`)
- Operational: `health`

Better Auth handles the authentication protocol separately through
`infrastructure/auth/auth.factory.ts` and `auth-hooks.ts`.

### Outbox

`infrastructure/outbox/outbox-event.routes.ts` is the complete routing table.
Three event types, each with one producer and one consumer:

| Event type                      | Producer                                        | Queue                 | Consumer                                      |
| ------------------------------- | ----------------------------------------------- | --------------------- | --------------------------------------------- |
| `agent-run.queued`              | `ai/execution/agent-run.service.ts`             | `agent-execution`     | `workers/handlers/agent-execution.handler.ts` |
| `knowledge-document.ingested`   | `features/knowledge/knowledge-ingestion.service.ts` | `knowledge-embedding` | `features/knowledge/knowledge-embedding.handler.ts` |
| `tool-execution.approved`       | `features/agent-management/approvals/agent-action-approval.service.ts` | `tool-side-effect` | `workers/handlers/side-effect-execution.handler.ts` |

Rows are appended inside the same transaction as the business write and drained
by `outbox-dispatcher.service.ts`. `OutboxRepository.append` takes a
`dedupeKey`.

### Queues

`infrastructure/queue/queue.config.ts` declares exactly three BullMQ queues:
`agent-execution`, `knowledge-embedding`, `tool-side-effect`. There is no
recurring or scheduled BullMQ job; the outbox dispatcher and the agent-run
reconciler (`ai/execution/agent-run-reconciler.service.ts`) are the periodic
work, and they are Nest services, not queue schedules.

### AgentRun lifecycle

`ai/execution/agent-run.service.ts`:

- Acceptance takes a per-organization advisory transaction lock
  (`pg_advisory_xact_lock`, `AGENT_RUN_CAPACITY_LOCK`), re-reads the
  idempotency key inside the transaction, enforces the in-flight cap
  (`assertCapacity`), creates the run, and appends `agent-run.queued` — all in
  one transaction.
- Idempotency is the unique pair `(organizationId, idempotencyKey)`. A losing
  concurrent insert is caught as `P2002` and resolved by re-reading the winner.
- Attempt fencing uses the BullMQ active-start ordinal:
  `claimExecutionAttempt` only advances on `attemptCount: { lt: attemptsStarted }`,
  and `markExecutionSucceeded` / `recordExecutionFailure` are conditional on
  the exact `attemptCount`, so a stale attempt cannot settle a newer one.
- `findStaleNonTerminal` and `reconcileTerminalFailure` support reconciliation
  of runs left non-terminal.

An MCP-driver run is created directly as `RUNNING` with `attemptCount: 1` and
appends no outbox event.

### Knowledge ingestion and embedding

`features/knowledge/knowledge-ingestion.service.ts` writes the document and
appends `knowledge-document.ingested`; `knowledge-embedding.handler.ts`
consumes it. Chunking is `chunking.ts`, retrieval is
`knowledge-retrieval.service.ts` over pgvector, and the agent-facing assembly
is `agent-context.assembler.ts`.

### Approvals, external effects, and OUTCOME_UNKNOWN

`core/external-effect.ts` types an external attempt as `accepted`, `rejected`,
or `unavailable`. `ToolExecutionStatus` in `apps/backend/prisma/schema.prisma`
adds `AWAITING_APPROVAL`, `APPROVED`, `REJECTED`, and `OUTCOME_UNKNOWN`, the
last commented in the schema as "Provider may have acted, so retrying would be
unsafe."

`ai/tools/tool.gateway.ts` records a proposal and returns
`{ status: 'awaiting_approval' }`. Approval in
`agent-action-approval.service.ts` appends `tool-execution.approved`, and
`workers/handlers/side-effect-execution.handler.ts` performs the effect and
settles the row, choosing `OUTCOME_UNKNOWN` over `FAILED` whenever the attempt
was ambiguous.

### MCP sessions

`features/agent-management/mcp/mcp-session.service.ts` opens a session as an
`AgentRun` on the `MCP_SESSION_RUNTIME` runtime, derives `expiresAt` from
`MCP_SESSION_TTL_MS`, and refuses an expired session with
`reason: 'session_expired'`. Closing is `AgentRunService.closeMcpSession` with
`closedBy: 'client' | 'expiry'`. Expiry is evaluated when a session is touched;
see the assumptions log below.

### Authentication mail and links

`infrastructure/auth/auth-mail.ts` supplies `sendVerificationEmail`,
`sendResetPassword`, and `sendInvitationEmail` to `auth.factory.ts`, which also
sets `invitationExpiresIn` and requires a verified mailbox before an invitation
is acted on. Mail transports live in `infrastructure/mail/` (log, Resend, SES,
SMTP) behind `mail-transport.ts`, with `mail-redaction.ts` for output. Sessions,
cookies, trusted origins, and redirect targets are configured through
`infrastructure/config/` and the platform's `safe-return-url.ts`.

Security mail today goes through the same `MailService` as everything else. It
has no dedicated worker or queue.

### Persistence

`apps/backend/prisma/schema.prisma` holds the models the migration touches:
`User`, `Session`, `Account`, `Verification`, `RateLimit`, `Organization`,
`Member`, `Invitation`, `AgentRun`, `OrganizationAgentInstallation`,
`OrganizationAgentVersion`, `ToolExecution`, `ToolExecutionApproval`,
`OutboxEvent`, the feature-flag and runtime-setting tables, `ManagedSecret`,
the two audit tables, `KnowledgeSpace`/`KnowledgeDocument`/`KnowledgeChunk`,
and `ContentProject`/`ContentDraft`.

Migrations are forward-only under `apps/backend/prisma/migrations/`, applied by
the `migrate` Compose profile.

### Composition and delivery

`docker-compose.yml` defines `postgres`, `postgres-test`, `redis`,
`redis-test`, `backend`, `worker`, `migrate`, `web`, `platform`,
`geoipupdate`, and an `edge` network. Profiles separate `development`, `test`,
`staging`, `production`, and `migration`. `docker-bake.hcl` builds four
targets: `backend`, `backend-migration`, `web`, `platform`. Delivery is
`.github/workflows/` plus the host bundle in `ops/`; see
[deployment state](../deployment-state.md) for what is actually provisioned.

## Mapping

Destination names are from ADR 0002 and do not exist yet.

| Today | Destination | Guarantees that must survive |
| --- | --- | --- |
| `apps/platform` `(platform)/organizations/**` | customer `app` surface | organization in the path is the authority scope; client gates stay presentation-only |
| `apps/platform` `(platform)/admin/**` | platform `admin` surface | platform roles stay separate from organization roles |
| `apps/web` | unchanged public site | no authenticated data on the public surface |
| `features/organizations`, `features/control-plane`, `features/content`, approvals, installations | Control Plane | tenant isolation; permission checks; audit trails |
| `ai/execution`, `ai/agents`, `ai/infrastructure/runtimes` | AI Runtime | attempt fencing; no direct product-table access |
| `ai/tools`, `workers/handlers/side-effect-execution.handler.ts` | Tool Executor | no effect before approval; `OUTCOME_UNKNOWN` never downgraded to `FAILED` |
| `infrastructure/outbox` + BullMQ queues | Temporal orchestration | transactional append with the business write; at-least-once delivery; dedupe key |
| `infrastructure/auth/auth-mail.ts` via shared `MailService` | Control Plane security mail, dedicated worker and queue | no token or credential in logs; link and redirect targets stay allowlisted |
| `features/knowledge` ingestion and embedding | Control Plane + Runtime split | space-scoped isolation; ingestion and embedding stay decoupled |
| MCP session handling on `AgentRun` | Runtime session handling | TTL expiry; session owner isolation |
| Document bytes in PostgreSQL/`KnowledgeDocument` | R2 for content, PostgreSQL for metadata and authorization | authorization never depends on the object store |
| `docker-compose.yml`, `ops/` | `infra` | Nginx stays the single ingress; migrations stay a separate composition root |

## Delivery exception for Phase A

Phase A ships as a stacked pair: RF-01 on `main`, RF-02 on the RF-01 branch.
The dependency is real — RF-02's gap matrix is written against the inventory
RF-01 records.

This is the stacking case [the delivery policy](../../.agents/policies/git-and-delivery.md)
already allows. It changes nothing else: no PR is merged by an agent, auto-merge
stays off, and after the parent merges the child is retargeted to `main` and
re-verified by a human.

## Assumptions and conflicts to verify in later phases

1. **MCP session cleanup.** Expiry is evaluated when a session is touched
   (`mcp-session.service.ts`). Whether an abandoned session is ever closed
   without a subsequent request is not established here. Confirm before the
   Runtime takes over session ownership.
2. **Approval does not suspend a run.** Today the tool returns
   `{ status: 'awaiting_approval' }` and the run continues to its own
   conclusion; the approval and the effect happen afterwards, off the run, via
   `tool-execution.approved`. A future design where the run waits for a human
   and then resumes is a product change. It is **not** implied by the
   restructuring and must not be introduced as a side effect of moving code.
3. **Knowledge document storage.** Moving content to R2 changes where bytes
   live but must not change who may read them. The authorization path needs to
   be traced before the move, not after.
4. **Security-mail extraction.** Better Auth calls the mail callbacks inline
   from `auth.factory.ts`. Putting them on a dedicated queue changes the
   failure mode of sign-up and password reset, so the acceptance behavior has
   to be settled before the extraction.
5. **Three composition roots, one schema.** The API, worker, and CLI roots
   share one Prisma client. Each extraction must state which root keeps
   database ownership.
