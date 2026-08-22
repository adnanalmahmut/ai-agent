# Backend

`apps/backend` is NestJS 11 with two entrypoints: `src/main.ts` serves HTTP and
`src/worker.ts` dispatches the transactional outbox and runs BullMQ consumers.
The API has no queue producer in request handlers; accepted asynchronous work
survives Redis outages in PostgreSQL.

`src/core` owns cross-cutting modules: auth, errors, GeoIP, health, HTTP/i18n,
lifecycle, mail, outbox, queue, rate limiting, Redis, and request logging.
`src/database` owns Prisma. Configuration is split into Zod-validated
`src/config/*.config.ts`; invalid required values fail at boot.

HTTP uses one response envelope, `AppException` machine codes, an exhaustive
HTTP/i18n mapping, Zod validation, request IDs, and Pino structured logs.
Liveness describes the process; readiness reports dependency degradation
without turning a recoverable Redis outage into an API restart loop.

Mail is provider-selected (`log`, SMTP, Resend, or SES) behind `MailService`.
Provider credentials are validated only when active, and outbound locale is
resolved from validated account/request state.

The agent feature currently provides only an internal durable acceptance
foundation. `AgentRunService` commits an application-owned AgentRun and its
`agent-run.queued` outbox event atomically, with organization-scoped PostgreSQL
idempotency. Each accepted run persists `agentVersion`, pinning it to the exact
definition revision it was accepted against, and `createdByUserId` is nullable
so work with no authenticated initiating user is representable. No public
create route or production agent definition is exposed, so this does not yet
let a user execute an agent.

Canonical implementation detail and delivery guarantees remain in
[`apps/backend/README.md`](../apps/backend/README.md).
