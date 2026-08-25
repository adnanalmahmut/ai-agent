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
an unregistered definition pair, a runtime mismatch, a model naming a provider
this build cannot authenticate — are recorded as final immediately instead of
consuming the retry budget. A provider that answered in the wrong shape is not
one of those: it may well answer correctly next time, so it keeps its retries.

A definition now also carries what it accepts, what it promises, and what it may
read. Both schemas are parsed rather than asserted, and the output schema is the
less obvious of the two: a model is an untrusted source that this application
happens to pay for, so a run that stored whatever came back would make
`AgentRun.output` a shape no consumer could rely on. Input is parsed again at
execution against the *pinned* version's schema, because a run accepted days
earlier must be checked against the definition it will actually run with.

`ContextPolicy` names the knowledge spaces an agent may read, by slug, with an
explicit chunk budget and an explicit character budget. The two are separate
because they bound different costs: the first bounds the retrieval, the second
bounds what is actually sent, which is what a provider bills for and what starts
displacing the instructions as a corpus grows. Assembly happens in the
application (`AgentContextAssembler`), not in the runtime — Mastra has its own
retrieval primitives, and using them would put the tenant predicate, the space
policy and the budget inside a framework this repository does not own. Slugs are
resolved against the caller's own organization, so a definition cannot name its
way into another tenant's material, and an agent with no policy gets nothing
rather than everything.

Retrieved passages travel to the runtime separately from the input and are
rendered into the *user* message, fenced and labelled as quoted material. They
are never merged into the instructions: they are organization data that some
member typed, and the system message is where the operator speaks. Angle
brackets inside a passage are replaced before it is fenced, so a document
cannot close the fence and continue in the position the preamble has told the
model is the caller's request. That is mitigation rather than proof — nothing
in a prompt makes a model incapable of following text it is shown — and what
keeps it from mattering today is that this milestone's agent has no tools and
no side effects. The fence is made unbreakable anyway, because an argument
resting on there being nothing worth stealing stops holding the moment the
agent gains a tool.

The provider credential is resolved per run from the encrypted store and passed
to the SDK on the model config. Mastra would otherwise resolve a bare
`provider/model` string by reading a provider environment variable, which would
mean the platform's key living in the worker's process environment for its whole
life and rotating only on a deployment. A definition naming a provider this
build holds no credential mapping for fails as a configuration error rather
than falling back to an environment variable, and composition asserts that no
registered definition does.

The generation call is bounded on the side that costs money. Everything
entering a prompt is already capped — the input schema on every field, the
context policy on chunks and characters — while nothing capped what came back,
and tokens are billed before the output schema gets to reject them. The
adapter sets an output-token ceiling, a wall-clock timeout so a stalled
provider does not hold a worker slot until BullMQ reclaims the job, and
`maxRetries: 0`, because retry belongs to BullMQ where each attempt is recorded
against the run rather than to an SDK loop that reports three calls as one.

`content-idea@1` (`src/agents/definitions/`) is the first production definition,
and `src/content-ideas/` is the business surface in front of it: one route to
request ideas and one to read the operation. Generation is asynchronous because
it is a provider call that takes seconds and can fail, so the request returns an
operation the caller polls; there is deliberately no synchronous variant.
Acceptance checks two flags, coarse first: `agents.enabled` is the switch that
stops every agent at once, and `content_ideas.enabled` is this feature's own.
It also enforces `agents.max_concurrent_runs_per_organization`, counting the
organization's `QUEUED` and `RUNNING` runs — a ceiling rather than a semaphore,
since two accepts racing can both observe room, so the bound is exceeded by at
most the number of requests in flight at that instant. It is checked after the
idempotency lookup, so a caller retrying a request that was already accepted is
never refused at a ceiling they are themselves occupying. The per-user rate
limit is not a substitute: that bounds one member, and the bill is the
organization's. Reading is ungated for the same reason knowledge reads are, and
an `Idempotency-Key` header is required — generation is
not naturally idempotent and a client retrying a timed-out request without one
would buy the same ideas twice. The stored key mixes the caller's key with a
digest of the parsed request, so an honest retry finds its own run while the
same key sent with a different body is a different key rather than a way to
receive somebody else's answer.

The control plane (`src/control-plane/`) holds operational state an operator can
change without a deployment: feature flags, typed runtime settings, and
encrypted provider credentials. Every key is registered in code with its schema,
default and bounds, so the Platform cannot create a setting nothing reads or
store a value outside the range the application is known to behave across.

Nothing there is cached. Evaluation is a query per check, deliberately: the
semantic the flags promise is that disabling a feature stops acceptance of new
work immediately, and any TTL turns "immediately" into "eventually" precisely
when an operator is switching something off because it is misbehaving. Disabling
a flag never cancels an accepted `AgentRun`; that durable contract is unchanged,
and hard cancellation is a separate feature.

Both composition roots get the control plane, but only the API gets its
controller — the worker imports the providers alone, because it resolves a
provider credential when it executes rather than receiving one in a job payload
that would sit in Redis and be as stale as the moment it was enqueued.

The Knowledge domain (`src/knowledge/`) holds organization-owned reference
material — spaces, documents, and embedded chunks — and answers one question:
which of an organization's passages bear on this, within the spaces the caller
was granted. Storage is PostgreSQL with pgvector, behind a `RetrievalPort`, and
the raw vector SQL exists in exactly two files so replacing the storage engine
is a change to those and to nothing else.

Isolation is a property of the ranking query, not of a filter applied to its
results. `organizationId` and `spaceId` are denormalized onto every chunk so the
predicate sits in the same row as the vector: ranking the whole table and
filtering afterwards would let another organization's closer material push this
one's out of the requested top-N before the filter ran — a leak that presents as
missing results rather than as an error. An empty granted-space list retrieves
nothing rather than everything, and a search with no organization is refused
before a query is built.

How much may be returned is the operator's, not the caller's:
`knowledge.retrieval_max_chunks` clamps the requested limit, because context
volume is a provider cost and a limit a caller can exceed is advisory.

Ingestion is content-addressed. A document is identified within its space by
title, and storing the same text again is recognized by checksum and does no
work: no new revision, no chunk rewrite, and no embedding event. Text that has
in fact changed increments the document's `revision`, replaces its chunks
wholesale, and appends one outbox event, all in the transaction that writes the
document. Chunking is paragraph-first and falls back to sentences and then to a
hard split, so a passage keeps as much of its own context as it can.

Embedding happens in the worker, off the request. The
`knowledge-document.ingested` event routes to the `knowledge-embedding` queue,
and the handler embeds only the chunks that lack a vector for the current model
— which is what makes it safe under at-least-once redelivery, and also what
makes a model change a matter of re-running rather than of migrating. The
outbox dedupe key is `${documentId}:${revision}`, so a second edit is a
different delivery rather than a repeat of the first. The embedding model is a
code constant rather than a runtime setting: the stored vectors' dimension
depends on it, so changing it is a re-embedding, not a configuration change.

Authorization is a guard, not a check inside the handler. Nest runs guards
before pipes, so an unauthorized caller is refused before the body is
validated, and cannot learn the request shape from validation errors. The guard
authorizes against the organization named in the path rather than the session's
active one, because an operator acting on an organization has not necessarily
switched into it. `knowledge.enabled` is asserted at the acceptance boundary,
where refusing new work is meaningful; retrieval does not consult it, because an
accepted run must be allowed to finish.

Both composition roots get the domain, but only the API gets its controller.
`KnowledgeCoreModule` carries the providers the worker needs; `KnowledgeModule`
adds the surface. The worker assembles an agent's context when the run executes
rather than from a snapshot taken when it was accepted.

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
