# Backend

`apps/backend` is NestJS 11 with three entrypoints: `src/main.ts` serves HTTP,
`src/worker.ts` dispatches the transactional outbox and runs BullMQ consumers,
and `src/cli.ts` runs operator commands and exits. Each has its own composition
root, so what a process cannot do is as much of the design as what it can: the
API has no queue producer in request handlers, and accepted asynchronous work
survives Redis outages in PostgreSQL.

The CLI exists for the one action that cannot be authorized, because it is what
makes authorization possible — creating the platform's first super
administrator. See [Operator commands](#operator-commands).

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

The agent feature provides internal durable acceptance and background execution
infrastructure. `AgentRunService` commits an application-owned AgentRun and its
`agent-run.queued` outbox event atomically, with organization-scoped PostgreSQL
idempotency. Each accepted run persists `agentVersion`, pinning it to the exact
definition revision it was accepted against, and `createdByUserId` is nullable
so work with no authenticated initiating user is representable. The worker
conditionally claims attempts and invokes Mastra behind the minimal
application-owned `AgentRuntime.run` boundary, with the SDK's own no-op logger
installed so provider request and response payloads cannot bypass Pino
redaction into container logs.

A worker-only reconciliation sweep finalizes runs whose queue job the transport
failed terminally without ever invoking the handler, which BullMQ does when a
job exceeds its stalled-job allowance. Deterministic configuration failures —
an unregistered definition pair, a runtime mismatch — are recorded as final
immediately instead of consuming the retry budget. Production definitions remain
empty and no public create route is exposed, so this still does not let a user
execute an agent.

## Operator commands

`src/cli.ts` runs one command and exits. Today that is
`super-admin:create`, which creates the platform's first super administrator.

The platform has a genuine chicken-and-egg problem: granting the super
administrator role is itself a super-administrator action, so nothing inside the
authorized surface can produce the first one. The alternative — creating an
administrator automatically at boot from configuration — would mean every
deployment of the image briefly contains an account whose credentials were
decided by an environment variable, which is a much worse failure than an
operator running one command.

So the command is constrained by *when* it may run rather than by who runs it:
it refuses while any super administrator exists, deactivated ones included. That
condition is reversible by a super administrator, so it is a safety interlock
rather than a security boundary — the real boundary is host access, and the
command is excluded from the deployment key's allowlist for that reason.

A PostgreSQL advisory lock on its own connection spans the check and the write,
because the condition is an absence and two concurrent operators would otherwise
both find it true. A half-created account is deleted before the error is
returned, since leaving one would close the gate permanently against an account
that cannot sign in.

The password is never an argument. On a terminal it is prompted for twice
without echo; otherwise the first line of stdin is used. `--password` is
rejected rather than ignored, because it would already be in the operator's
shell history by the time the command saw it.

Operator procedure, exit codes, and the `emailVerified` trade are in
[`docs/operations-runbook.md`](operations-runbook.md).

Canonical implementation detail and delivery guarantees remain in
[`apps/backend/README.md`](../apps/backend/README.md).
