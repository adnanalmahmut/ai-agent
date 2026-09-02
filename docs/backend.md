# Backend

`apps/backend` is NestJS 11 with three entrypoints: `src/main.ts` serves HTTP,
`src/workers/main.ts` dispatches the transactional outbox and runs BullMQ consumers,
and `src/cli.ts` runs operator commands and exits. Each has its own composition
root, so what a process cannot do is as much of the design as what it can: the
API has no queue producer in request handlers, and accepted asynchronous work
survives Redis outages in PostgreSQL.

The CLI exists for the one action that cannot be authorized, because it is what
makes authorization possible — creating the platform's first super
administrator. See [Operator commands](#operator-commands).

`src/infrastructure` owns technical application modules: auth, configuration,
Prisma, GeoIP, health, HTTP/i18n, lifecycle, mail, outbox, queue, rate limiting,
Redis, and request logging. `src/core` remains deliberately small and currently
owns only generic application errors. Configuration is split into Zod-validated
`src/infrastructure/config/*.config.ts`; invalid required values fail at boot.

HTTP uses one response envelope, `AppException` machine codes, an exhaustive
HTTP/i18n mapping, Zod validation, request IDs, and Pino structured logs.
Liveness describes the process; readiness reports dependency degradation
without turning a recoverable Redis outage into an API restart loop.

Mail is provider-selected (`log`, SMTP, Resend, or SES) behind `MailService`.
Provider credentials are validated only when active, and outbound locale is
resolved from validated account/request state.

The organization business-settings domain (`src/features/organizations/settings/`) owns
the typed defaults and profile that sit beside Better Auth's name, slug, and
logo. `GET` and full-replacement `PUT` at
`/organizations/:organizationId/business-profile` are path-scoped by the
existing `organization:update` permission; the guard runs before body parsing,
so a caller cannot use validation failures to probe an organization they cannot
administer. The contract accepts only the application's `ar`/`en` locales,
runtime-supported IANA timezones and ISO 4217 currencies, bounded nullable
business text, and HTTP(S) website URLs. Writes enumerate owned fields and use
an application-specific version token for compare-and-swap. Repeating an
already-applied replacement is a no-op, while a stale replacement that would
change state is a conflict rather than a silent overwrite.

The organization product-audit domain (`src/features/organizations/audit/`) records
meaningful tenant mutations separately from application logs, agent execution,
and the operator-only control-plane history. Its closed actions are
`organizationBusinessProfile.replaced` and `contentProject.created`. A real
profile change and its event are written in one Prisma transaction; no-ops and
losing compare-and-swap attempts append nothing. The event carries the
organization, authenticated actor, subject, time, and a closed before/after
projection containing only the bounded fields of the subject it describes.
There is no generic metadata or request-body input.
`GET /organizations/:organizationId/audit-events` is rooted in the path tenant,
guarded by `organization:update`, bounded to 100 rows, and keyset-paged newest
first on `(occurredAt, id)`. No application route or service updates or deletes
product history; PostgreSQL also rejects direct UPDATE and DELETE statements on
the table. Organizations must treat the API as indefinitely retained history
until a separately approved product/legal retention policy revises the database
guard.

The agent feature provides internal durable acceptance and background execution
infrastructure. `AgentRunService` commits an application-owned AgentRun and its
`agent-run.queued` outbox event atomically, with organization-scoped PostgreSQL
idempotency. Each accepted run persists `agentVersion`, pinning it to the exact
definition revision it was accepted against, plus the immutable organization-
agent version selected from the enabled active installation in the same
transaction. It also pins that definition's stable model-policy revision, the
organization-selected stable model identity, and the catalog price revision
effective at the persisted acceptance instant. Definition revision and runtime
are code-derived rather than caller-selected. `createdByUserId` is nullable so work with no authenticated
initiating user is representable. The worker conditionally claims attempts,
reloads and revalidates the pinned organization configuration from PostgreSQL
on every attempt, and invokes Mastra behind the minimal application-owned
`AgentRuntime.run` boundary, with the SDK's own no-op logger installed so
provider request and response payloads cannot bypass Pino redaction into
container logs.

A worker-only reconciliation sweep finalizes runs whose queue job the transport
failed terminally without ever invoking the handler, which BullMQ does when a
job exceeds its stalled-job allowance. Deterministic configuration failures —
an unregistered definition pair, a runtime mismatch, or a model identity the
application catalog cannot resolve for agent execution — are recorded as final
immediately instead of consuming the retry budget. A provider that answered in
the wrong shape is not one of those: it may well answer correctly next time, so
it keeps its retries.

A definition now also carries what it accepts, what it promises, and what it may
read. Both schemas are parsed rather than asserted, and the output schema is the
less obvious of the two: a model is an untrusted source that this application
happens to pay for, so a run that stored whatever came back would make
`AgentRun.output` a shape no consumer could rely on. Input is parsed again at
execution against the *pinned* version's schema, because a run accepted days
earlier must be checked against the definition it will actually run with.

Definitions may additionally own an organization-configuration schema and
default. Presence makes that exact definition revision installable; absence
keeps it internal-only. The API exposes the latest installable revision of each
agent as a finite catalog, but create and replace always resolve the exact
requested `(agentId, definitionVersion)` and parse configuration with that
revision's Zod schema. `content-idea@1` deliberately accepts only a strict empty
object: it has no organization knob the runtime consumes, so arbitrary JSON —
especially credentials — is refused rather than persisted as speculative
product contract.

Every definition also owns an immutable model-policy identity, a finite allowed
model set, and one default member. Registry composition rejects empty,
duplicate, capability-incompatible, or default-excluding policies. Installation
create/replace may select only a stable catalog `modelId` inside that exact
definition revision's set; provider router aliases and arbitrary strings never
cross the request schema. The policy and selected model are copied to the new
immutable organization version. Today's production set is intentionally the
single justified generation model, so this is an enforced policy boundary, not
a speculative model picker.

`OrganizationAgentInstallationService` owns one installation per organization
and agent plus append-only effective versions. Creating commits the
installation, revision 1, and its active pointer together. Replacing enabled
state, definition revision, or configuration inserts one immutable version and
switches the pointer with an optimistic revision comparison in the same
transaction. A CAS loser inserts no candidate; a stale request matching the
winner is an idempotent success, while a different winner is a conflict. The
database also enforces unique `(installationId, revision)` pairs. That compound
constraint is scoped to one installation, while a deferred active-pointer
foreign key lets CAS run before candidate insertion. Only the CAS winner writes
the next version; different installations may independently use the same
revision numbers. The
authorized management and history routes use path-scoped `organization:update`
and always include that organization in database predicates. Agent-run
acceptance now resolves the enabled active version inside its run/outbox
transaction, and execution reloads that immutable version by the run's durable
tenant-bound reference rather than consulting the current pointer.

New-run entitlement deliberately uses the explicit-installation cutover
(Option A). Control-plane permission (`agents.enabled` and the agent-specific
flag) and organization product state are separate gates: a feature flag never
creates or implies an installation. An existing organization with no
installation receives the bounded `agent_not_installed` result; an installation
whose active version is disabled receives `agent_disabled`; only an installed,
enabled active version may proceed to the remaining acceptance gates. The run
path does not backfill, lazily create, or first-run-create an installation and
does not fall back to the global code definition as an effective installation.
Installation is organization-owned state selected through the authorized
installation API. This train adds no Platform management UI, so an authorized
API caller must install the agent before the existing content-idea surface can
accept a run; the frontend reports the bounded state and never auto-installs.
Historical pre-AGT-02 rows with a null organization-agent-version reference
remain valid and execute their pinned definition revision's code-owned default.
That compatibility path never consults today's installation and is not
available to newly accepted runs.

`ContextPolicy` names the knowledge spaces an agent may read, by registry slug,
with an explicit chunk budget and an explicit character budget. The slug type is
the knowledge registry's rather than `string`, so a policy naming a space that
does not exist is a compile error — it used to be a silent one, because a slug
nothing resolves and a space with nothing in it are the same observation at
retrieval time. A composition test asserts the same thing at runtime for any
definition that reaches the shape through a cast. The two are separate
because they bound different costs: the first bounds the retrieval, the second
bounds what is actually sent, which is what a provider bills for and what starts
displacing the instructions as a corpus grows. Assembly happens in the
application (`AgentContextAssembler`), not in the runtime — Mastra has its own
retrieval primitives, and using them would put the tenant predicate, the space
policy and the budget inside a framework this repository does not own. Slugs are
resolved against the caller's own organization, so a definition cannot name its
way into another tenant's material, and an agent with no policy gets nothing
rather than everything.

### Governed tool execution

An agent may also *call* something, through a code-owned tool registry rather
than an SDK's. A `ToolDefinition` is identified by an exact `(id, version)`
pair, carries Zod schemas on both sides, and declares a `read_only` or
`side_effect` risk. The risk selects the lifecycle: a read-only tool runs inline
during the generation and its result goes back to the model; a side-effect tool
never runs inline — the model may only *propose* it, and the effect happens in
the worker after a human decision (see
[Human approval and the idempotent side effect](#human-approval-and-the-idempotent-side-effect)).
Composition fails loudly on a duplicate identity, an invalid version, a
registered tool nothing declares, a declared tool nothing registers, a
registered tool with no implementation, and a tool whose risk class and
implementation shape disagree — a `side_effect` definition with an inline
`execute` would be an effect the generation performs.

Capability narrows in two steps. `AgentDefinition.maxToolGrants` is the most an
immutable definition revision may ever call — a maximum, like `modelPolicy`, so
changing it means publishing a new revision. `OrganizationAgentVersion.toolGrants`
is the tenant's selection within that maximum, validated on write and refused
rather than trimmed when it names something outside it. An accepted run already
pins its organization version, so that pin is the durable authority for its
grants: a grant added or removed afterwards belongs to a different version row
and changes nothing for a run already in flight.

`ToolGateway` holds every authority check and hands the runtime nothing but
closures already bound to the run they belong to. The interesting property is
not that it checks the caller's identity but that the caller cannot express one:
a tool's input schema has no field for an organization, a run, a version, or a
scope, so the model can choose a question and nothing else. Inputs are parsed
again even though the SDK validates them, because SDK validation sits on the far
side of a boundary this repository does not own.

`ToolExecution` records what actually ran: the organization, the run and its
attempt, the exact tool id and version, the parsed input, the parsed result, and
timestamps. It references its run through the composite
`(agentRunId, organizationId)`, so PostgreSQL refuses a cross-tenant row. The
row is written after authorization and before the implementation, so its
existence means "this was permitted and handed over" — a refused call leaves no
row, and is therefore never mistaken for a failed one. A failure stores a code
from a closed union, so no provider or driver text can reach the column. There
is deliberately no reconciler: a read-only execution left `STARTED` by a process
death is an honest "outcome unknown" for an operation that changed nothing
outside this system.

The lifecycle `STARTED -> SUCCEEDED | FAILED` is enforced rather than described.
Both terminal writes are one compare-and-set: the update requires `status`
`STARTED` alongside the tenant-scoped id, and requires exactly one row to
change. A settled execution therefore cannot be rewritten in either direction,
and a terminal write matching no row fails closed instead of resolving — which
is what stops `ToolGateway` returning an output to the model that no durable row
claims was ever completed.

`knowledge.search@1` is the first tool, and it is `AgentContextAssembler` again
rather than a second retrieval path — the same tenant scoping, the same
`ContextPolicy` as maximum visibility, the same operator-owned ceiling. The
model supplies a bounded query; it does not supply a corpus. An agent whose
definition permits no knowledge searches nothing.

Two properties of the runtime boundary are enforced against the installed SDK
rather than assumed. Mastra keys its tool record by the model-facing name and
rewrites any key outside `^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$`, so tools declare an
explicit audited `runtimeName` and both the registry and the adapter refuse one
that would be rewritten — otherwise the durable identity `knowledge.search@1`
would reach the provider as something nobody reviewed. And the agent loop's step
ceiling defaults to `stepCountIs(5)` as a runtime literal declared in no type
definition, so a tool-enabled generation passes `maxSteps` explicitly rather
than depending on a number that can change in a patch release with no type-level
signal. A generation granted no tools passes none: `maxSteps` composes into the
loop's stop conditions, so applying it to a definition that cannot emit a tool
call would change a shipped agent's runtime behavior for a capability it does
not use.

What a failed tool sends the provider is bounded by construction, and the
mechanism is worth stating precisely because the obvious reading of it is wrong.
The installed SDK wraps whatever a tool throws in an error of its own, keeping
the original as `cause`; it serializes *that wrapper* into
`{ name, message, stack, ...own enumerable properties }`; and it renders the
result to the model, which for an application-executed tool means the message
alone. So the only value a tool may throw is a containment type whose message is
a constant naming the tool — that constant is what bounds the transcript, since
anything a driver or implementation raised would otherwise be transmitted
verbatim and Pino's redaction is nowhere near that path. The type additionally
carries no stack, because the wrapper keeps it reachable as `cause` and a stack
there would put this repository's source paths on every consumer of the failure.
Both halves are asserted against the real SDK rather than argued. The sentence
names the tool by its audited `runtimeName`, which is the only name the model
was offered; the durable `id@version` stays in the `ToolExecution` row, which is
the authority on what happened.

The reverse direction — what a tool *call* can put in this application's logs —
needs a dependency patch, and it is the only one in the repository.
`@mastra/core`'s AI-SDK-to-Mastra chunk transform parses the model's tool-call
argument string, and when both `JSON.parse` and its repair pass fail it calls
`console.error` directly with the raw string. That call takes no logger and
nothing gates it, so the adapter's logger containment cannot reach it and Pino
never sees it to redact it. The argument is model-generated text composed after
the model was shown the organization's knowledge passages, and reaching the
branch needs no adversary: the repair pass cannot close a string truncated by
`maxOutputTokens`. Before this build had tools the line was unreachable.

No supported option, hook or newer release avoids it — the emission is
unconditional and identical in 1.63.2, the newest release at the time of
writing. `patches/@mastra__core@1.61.0.patch` therefore replaces that one
emission, in the ESM and CJS bundles, with a bounded constant carrying no value.
It changes nothing else, and `pnpm` refuses to install when a patch no longer
matches its pinned version, so an upgrade cannot silently drop it. A real-SDK
regression asserts the malformed argument reaches no console sink.

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

### Human approval and the idempotent side effect

`notification.send@1` (`runtimeName` `notification_send_v1`) is the one
side-effecting tool, and the shape of everything around it is the point of the
slice: one email to one member of the caller's own organization, proposed by the
model and performed by nobody until an authorized person decides.

The model supplies `{ recipientMemberId, subject, body }` and nothing else. The
recipient is a *membership* id resolved against the run's organization — an
address field would make the tool an exfiltration channel for anything the
model has been shown — and the sender, provider, credential, time of sending,
idempotency key, approver and execution id all come from application state.
Subject and body are bounded (120 and 2,000 characters) because they become the
message verbatim.

**Proposal.** When the model calls the tool, `ToolGateway` parses the input,
lets the implementation refuse a recipient who is not a deliverable member here
(nothing durable is written for a refused call), and then records, in one
transaction, a `ToolExecution` in `AWAITING_APPROVAL` and one
`ToolExecutionApproval` in `PENDING` carrying a digest of the parsed input. The
model is told `{ status: 'awaiting_approval' }` and no identifier. The run may
finish; the execution's lifecycle continues without it.

**Decision.** `agentActionApproval:read` is ordinary membership;
`agentActionApproval:decide` belongs to `admin` and `owner`, enforced by the
shared organization guard against the organization in the path. Approve and
reject are compare-and-set transitions on two rows in one transaction — the
approval leaves `PENDING`, the execution leaves `AWAITING_APPROVAL` — each
requiring exactly one row to have moved. A second decider, a concurrent
opposite decision, or a replay matches nothing and is refused with `CONFLICT`
(`already_decided`); under READ COMMITTED the losing `UPDATE` waits for the
winner to commit and re-evaluates its predicate. For an approval the
`tool-execution.approved` outbox event (payload `{ toolExecutionId,
organizationId }`, dedupe key the execution id) and the
`agentActionApproval.approved` audit row are written in the same transaction,
so "approved" and "queued to perform" are one fact. A rejection writes
`REJECTED`, the audit row, and no event.

**Revalidation, then the effect.** `SideEffectExecutionHandler` runs in the
worker only and is handed two identifiers; every database call it makes is
contained to a constant, so a Prisma rejection never becomes BullMQ's
`failedReason`. It re-derives every fact from
PostgreSQL: a terminal execution is a no-op, a non-approved one performs
nothing, and before any provider call it checks that the organization is still
operational, that the approval still stands and its digest still equals the
digest of the stored input, that the run's pinned `OrganizationAgentVersion`
and definition revision still grant exactly this tool, and — through the tool's
own `prepareEffect` — that the recipient is still a member of this organization
with a deliverable account. Any failure settles `FAILED` with a closed code
(`precondition_organization`, `precondition_authority`,
`precondition_approval`, `precondition_recipient`, `delivery_unsupported`) and
sends nothing.

**Idempotency.** The provider call carries the key
`notification.send@1:<toolExecutionId>` — derived from durable identity, stored
nowhere, identical on every retry. Resend keeps a key for 24 hours; inside that
window the same key with the same payload replays the original response and
email id without sending again, a changed payload is `409
invalid_idempotent_request`, and a concurrent duplicate is `409
concurrent_idempotent_requests`. The worker claims each attempt by
compare-and-set on `effectAttemptCount`, so two deliveries of one action cannot
both proceed; the first attempt records when it began and a digest of the
effective payload (address, subject, text), and a later attempt whose payload
differs or that arrives after the 20-hour safe window is settled
`OUTCOME_UNKNOWN` without calling the provider. An `accepted` answer settles
`SUCCEEDED` with the provider's message id; a deterministic refusal on a first
attempt settles `FAILED` with `provider_rejected`; anything else retries with
the same key through BullMQ's bounded attempts, and on the last attempt settles
`OUTCOME_UNKNOWN`. That state exists because the alternative is a lie:
`FAILED` claims nothing was sent, and a lost response cannot support that
claim. The same rule governs every refusal reached after an attempt has been
claimed: a recipient who left between attempts, an organization archived
between attempts, or a provider `409` for a payload it considers changed all
settle `OUTCOME_UNKNOWN`, because they say the message must not be sent
again, not that it was never sent. `FAILED` is reserved for a refusal before
the first provider call. The attempt fence stops two deliveries holding the
same attempt; it does not make the provider call mutually exclusive, and the
key is what makes two concurrent calls one send. Exactly-once is not asserted; at-least-once delivery with a provider
that deduplicates on a stable key is what is asserted, and the guarantee ends
where the provider's window does.

The delivery port (`NOTIFICATION_DELIVERY`) is separate from `MailService`,
whose fire-and-forget `dispatch` was designed for auth mail where a duplicate is
tolerable. The Resend adapter passes the key and reads nothing from an error but
its stable code and status, which select a classification; the `log` driver is
trivially idempotent; SES and SMTP have no request-level key and answer
`delivery_unsupported`, so the effect fails closed on them rather than sending
once and hoping. Nothing from a provider response — code, prose, headers, the
key — reaches the execution row, the audit row, a log line, the API, or the
model transcript.

### MCP as an adapter over the same gateway

An external MCP client can call the tools an organization granted an installed
agent. It reaches them through `ToolGateway` — the same object Mastra runs
behind — so there is no second registry, no second grant model, no second
`ToolExecution` writer, and no second approval implementation. The claim worth
stating is negative: an MCP client cannot send a notification. It can only
propose one, because the closure it is handed writes an `AWAITING_APPROVAL` row
and returns, and a person still decides.

The adapter (`createGovernedMcpServer`) receives `AgentRuntimeTool[]` and
nothing else — a name, a description, two schemas, and a closure already bound
to one run in one organization. It holds no gateway, registry, Prisma client,
grant state, organization id or run id, so no authority decision is available
to it, correctly or otherwise. The schemas it publishes are the
`ToolDefinition`'s own, so what a caller is told and what is enforced cannot
drift.

**A session is an `AgentRun`.** `ToolExecution` requires a run in the same
organization and that composite foreign key is the tenant boundary, so the
alternative was making tenant authority nullable to suit an adapter. A session
therefore needs no new table and no new column. Acceptance is otherwise the
ordinary path — the same per-organization advisory lock, exact in-flight
ceiling, durable idempotency and definition/organization-version pinning — with
one `driver` field distinguishing it.

The worker cannot execute a session, for three reasons that hold independently.
No job exists, because acceptance appends no outbox event for a session. If one
somehow did, `AgentRunner` refuses before any runtime is resolved: it compares
the definition's runtime against the row's and throws when they disagree, which
they always do, because the definition says `mastra` and the row says `mcp` —
that is the check which would actually fire, and the runtime registry is never
asked about `AgentRun.runtime` at all. And `mcp` is deliberately not a member of
`AGENT_RUNTIME_NAMES`, the constant that types `AgentDefinition.runtime`, so no
definition can ever declare it — which is what makes that disagreement
unconditional rather than a coincidence of the definitions that exist today.

**Lifetime is bounded and terminal.** The lifetime is absolute from acceptance
(60 minutes), not sliding, which is what makes the worst case a number. `DELETE`
closes a session as `SUCCEEDED` with `{ closedBy: 'client' }`; an expired
session is closed by whichever request discovers it, and one nobody returns to
is closed by `AgentRunReconciler` with `{ closedBy: 'expiry' }`. Closing is a
compare-and-set on the tenant, runtime and `RUNNING`, so two observers cannot
both write an outcome. The tradeoff of modelling a session as a run is
deliberate and load-bearing: a session occupies one of the organization's
in-flight slots under
`agents.max_concurrent_runs_per_organization` until it ends, because it is
in-flight agent activity that spends the platform's provider credential on
every call.

**Authority is re-derived per request, nothing cached.** Each exchange re-reads
the run under `{ id, organizationId, runtime: 'mcp' }`, requires it `RUNNING`,
unexpired and created by the authenticated user, resolves the pinned definition
revision, reads the pinned `OrganizationAgentVersion` for its grants, and calls
`ToolGateway.authorize`. The protocol SDK's server factory runs once per
request and derives `tools/list` from that instance's registrations, so a
per-request tool set is the supported shape rather than a workaround — and
`tools/list` is exactly the effective grant set. Because what is read is the
*immutable* pinned version rather than the installation's current one, a grant
changed while a session is open does not alter that session.

`mcpSession:create` is `admin` and `owner`. Routes that drive the session
additionally require the caller to be the member who opened it: a permission
answers "may this person open sessions here", not "is this person's session",
so an id is not a capability and a reconnecting client manufactures no
authority. Closing is the one operation an organization admin or owner may
perform on another member's session, to recover in-flight run capacity if an
opener disconnects; ordinary members cannot close it. A session that does not
exist, belongs to another organization, belongs to another member (for
exchange), or is a worker run rather than a session all answer `404` — a refusal
must not confirm what exists elsewhere.

Two bounds exist because the adapter introduces a request boundary the rest of
the design does not have. The gateway's `MAX_TOOL_INVOCATIONS_PER_ATTEMPT` is
captured inside one `authorize()` call, so a session authorizing once per
request would receive a fresh budget every request and could make an unbounded
number of paid embedding calls; the adapter therefore enforces a durable
per-session cost budget / bounded ceiling with concurrent overshoot by
counting the session's own `ToolExecution` rows before each call. It is a cost
ceiling rather than a fence, and the difference is stated rather than blurred:
counting and calling are not one atomic step, so concurrent calls can each read
the same count and overshoot by the number in flight together. What keeps that
number small is that a modern exchange carries exactly one tool call, leaving
the per-user rate limit as the real ceiling on concurrency. Making it exact
would mean fencing it in the transaction that writes the row, or in Redis; that
is a deliberate non-goal, because the purpose is to stop a session quietly
spending all month, not to meter it to the call. And `mcp.enabled` — default
off, like every other acceptance boundary that spends money — is checked on
*every* exchange rather than only at acceptance, because a session outlives the
request that opened it and a gate on acceptance alone would leave open sessions
spending after an operator had stopped the feature.

Transport boundaries are the adapter's own responsibility because the SDK
declines them. `Origin` is validated against `BETTER_AUTH_TRUSTED_ORIGINS`: the
specification requires a streamable-HTTP server to validate it, and it earns its
place here because this endpoint is authenticated by a session cookie. Absence
passes, since a non-browser MCP client sends none. The validation uses exact
origin semantics: scheme + hostname + effective port. An incoming Origin must
match one of the deployment's configured trusted origins exactly, preventing
DNS rebinding and cross-scheme or cross-port attacks across different ports on
the same host. For the same reason only content negotiation and
`mcp-`-prefixed protocol headers are forwarded to the SDK — passing headers
wholesale would hand a credential to a third-party library with no use for one.
A tool failure crosses as the gateway's constant sentence and nothing else; an
unknown tool name fails closed as a protocol error.

The endpoint serves one protocol revision, and that is a security decision as
much as a compatibility one. `legacy: 'reject'` turns off the SDK's older leg,
which accepts a JSON-RPC array and dispatches every element without awaiting any
of them: one HTTP request — one rate-limit point, one authorization, one durable
tool-call count — would otherwise fan out into as many concurrent tool calls as
the gateway's per-attempt budget allowed, each having read the same count. It
also makes `responseMode: 'json'` describe the whole endpoint rather than half
of it, because the legacy leg answers request-bearing POSTs as
`text/event-stream` regardless. The cost is real and worth naming: the v2 client
negotiates the legacy era by default, so a client must ask for 2026-07-28
explicitly.

`subscriptions/listen` is refused rather than served. The protocol entry serves
it itself, as an event stream that ends only when its consumer cancels or the
handler closes — so reading it to completion, which answering one HTTP request
with one protocol response requires, never returns, and the socket, the
keepalive timer and the per-request server instance would be held until the
process ended. Refusing is also the honest answer: this server registers no
resources or prompts and declares `tools.listChanged: false`, so it has nothing
to notify anybody about. The refusal is stated twice — once as a method check
before the SDK is reached, once as a zero subscription ceiling the router
enforces — and a deadline on the response read bounds anything neither
anticipated. GET and DELETE on the protocol path answer `405` with a JSON-RPC
body, as the specification asks, so a client probing for the deprecated
transport is not pushed down it by this application's error envelope.

An operator's switches reach an open session. `mcp.enabled` is re-checked on
every exchange, and so is the installation's own `enabled` flag: a session lives
up to an hour under a client's control, so checking either only at acceptance
would leave an agent that had been switched off still answering calls and
proposing actions for the rest of that hour. New and subsequent exchanges are
refused after an agent is disabled, the session is closed, or the feature is
switched off. An already authorized in-flight exchange is not synchronously
cancelled in flight; and side-effect tools still cannot perform a provider effect
without the separate human approval path. The grant set still comes from the
version the run pinned — what an operator may change is whether this agent runs
at all, not what an accepted run may call.

Two honest limitations. Authentication is the application's existing session,
and authorization is `OPTIONAL` in the current MCP specification, so no
credential product was built: a desktop MCP client that cannot present this
application's session cookie cannot use this endpoint, and building an
authorization server would be a second authentication system and a separate
decision. And a repeated `Idempotency-Key` answers with the stored session
whatever became of it, because that is what the shared acceptance path means by
idempotency — so re-opening with a spent key returns the closed session's id and
the next exchange refuses it, rather than quietly starting a second session
behind one key.

The code-owned model catalog is the application's finite provider/model
vocabulary. It currently contains only the two models real source paths use:
`openai.gpt-4o-mini` for structured agent generation and
`openai.text-embedding-3-small` for 1536-dimension knowledge vectors. Stable
application identities are separate from the exact provider identifiers sent
to adapters. Exact lookup has no alias, latest-model, or other-model fallback;
agent selection additionally requires the current text-input, text-output,
structured-output, and Mastra compatibility contract. Provider capabilities
that the product does not expose, such as image input, do not become an
application input boundary merely because the provider supports them.

The same catalog carries immutable, effective-dated USD token-price revisions.
Rates are exact integer USD micros per one million tokens and intervals are
half-open, so resolving model X at instant T returns exactly one stable revision
or fails. The initial entries record official OpenAI source URLs and retrieval
dates. This is operational application policy, not a claim that provider prices
are immutable: a changed price adds a new non-overlapping revision and leaves
historical entries intact. At run acceptance, the applicable price identity is
resolved inside the same transaction and the exact instant is written as
`AgentRun.createdAt`. Workers revalidate the pinned policy, model capability,
and price interval on every attempt before the runtime call. Token quantities,
aggregation, usage ledgers, and billing remain outside this slice.

The provider credential is resolved per run from the encrypted store and passed
to the SDK on the model config. The Mastra adapter translates the run-pinned
stable identity to the catalog's exact `provider/model` router identity; it
never re-reads the installation pointer or substitutes the definition default
for a newly accepted run. Handing Mastra
a bare router string would otherwise make it read a provider environment
variable. That would leave the platform key in the worker environment for its
whole life and make rotation require a deployment. A catalog provider for which
this build holds no credential mapping fails as a configuration error rather
than falling back to an environment variable, and composition asserts every
registered definition resolves as an application agent model.

The generation call is bounded on the side that costs money. Everything
entering a prompt is already capped — the input schema on every field, the
context policy on chunks and characters — while nothing capped what came back,
and tokens are billed before the output schema gets to reject them. The
adapter sets an output-token ceiling, a wall-clock timeout so a stalled
provider does not hold a worker slot until BullMQ reclaims the job, and
`maxRetries: 0`, because retry belongs to BullMQ where each attempt is recorded
against the run rather than to an SDK loop that reports three calls as one.

`content-idea@1`'s request contract is `topic` (3–200), `goal` (3–300),
`language` (`ar` or `en`), optional `audience` (3–200) and `guidance` (≤1000),
and `numberOfIdeas` (1–10, default 5). It answers with `ideas` — each carrying
`title`, `hook`, `angle`, `summary`, and a `suggestedFormat` of `carousel`,
`post`, or `video` — plus `sources` naming the spaces it drew on.
`numberOfIdeas` is an output guarantee rather than a prompt hint: a definition
may declare an `outputContract`, checked by `AgentRunner` after the output
schema parses and before any durable success is written, and this one requires
the answer to carry *exactly* the requested number of ideas. A wrong count is a
provider-output failure — a plain error that keeps its BullMQ retry budget, not
an `AgentConfigurationError` — because a model that miscounted once may count
correctly on the next attempt. A contract returns a closed
`AgentOutputContractViolation` (a listed code, plus two integers for a count)
rather than a string, and `AgentOutputContractError` composes the message: the
type carries no text, so no provider output can reach a log, `failedReason`, or
`AgentRun.lastError` even from a future contract that tried. A contract that
cannot reach a verdict returns `unverifiable`, which is a refusal — "I could not
check" and "it is fine" are different answers and only one is safe to store. The
error class exists to be *named*, not to be classified differently: the worker
reads it only to log `reason: contract_violation` instead of `runtime_error`, so
a model that has started miscounting is distinguishable from a provider outage
while being retried identically. `language` is
the language of the *content*, chosen per request: it is never inferred from the
Platform's UI locale, because an Arabic-speaking marketer writing English
campaign copy is the ordinary case rather than the exception. Its context policy
reads exactly `organization.profile`, `brand.voice`, `audience`, and
`content.strategy`, with `maxChunks: 12` and `maxCharacters: 12_000`. The four
spaces it does *not* read are the more interesting half: `brand.identity` is
positioning and legal claims, `products.services` is specifications most likely
to be restated as fact in a caption, `design.system` has nothing to say about
prose, and `faq` holds the organization's most quotable liabilities.

A repository-owned evaluation set
(`src/features/content/ideas/agent-definitions/__tests__/content-idea.eval-cases.ts`) drives every case
through the real runner, assembler, and adapter with three fakes at the edges.
It measures application-owned behavior — normalization, language and goal
reaching the prompt, context drawn only from the declared spaces, cross-tenant
isolation, both budgets binding, and the output being both parsed and contracted
against the requested idea count before it is stored — and it deliberately
measures nothing about model quality.

`content-idea@1` (`src/features/content/ideas/agent-definitions/`) is the first production definition,
and `src/features/content/ideas/` is the business surface in front of it: one route to
request ideas and one to read the operation. Generation is asynchronous because
it is a provider call that takes seconds and can fail, so the request returns an
operation the caller polls; there is deliberately no synchronous variant.
Acceptance checks two flags, coarse first: `agents.enabled` is the switch that
stops every agent at once, and `content_ideas.enabled` is this feature's own.
It also enforces `agents.max_concurrent_runs_per_organization`, counting the
organization's `QUEUED` and `RUNNING` runs. The bound is **exact**, not
best-effort: counting and inserting is a read-modify-write, and PostgreSQL's
default isolation lets two of them interleave — both read the same count, both
see room, both commit — with nothing afterwards to show for it except a larger
bill than the operator set. The count and the insert therefore happen inside a
transaction-scoped advisory lock keyed on the organization
(`pg_advisory_xact_lock(namespace, hashtext(organizationId))`), so acceptance is
serialized per tenant and two organizations never block each other. The
idempotency lookup is repeated inside that lock and *before* the capacity check,
so a caller retrying a request that was already accepted is answered with their
run even while the organization is at capacity. Deliberately not a Redis
semaphore: Redis is disposable coordination here, and a semaphore there would
grant capacity that stopped matching the durable rows the moment it was
flushed. The per-user rate
limit is not a substitute: that bounds one member, and the bill is the
organization's. Reading is ungated for the same reason knowledge reads are, and
an `Idempotency-Key` header is required — generation is
not naturally idempotent and a client retrying a timed-out request without one
would buy the same ideas twice. The stored key mixes the caller's key with a
digest of the parsed request, so an honest retry finds its own run while the
same key sent with a different body is a different key rather than a way to
receive somebody else's answer.

`src/features/content/projects/` is what happens after the ideas come back. One route
promotes a single idea into a `ContentProject`, and two read what has been
promoted. Creation is synchronous — unlike generation it spends no provider call
and writes two rows in one transaction, so there is nothing to poll.

The request names a run and an index; it never carries the idea's text. A
request shaped to accept the prose would let a member persist words the agent
never produced while the row still pointed at a real run, and nothing
afterwards — screen, export, or audit — could tell the difference. The server
therefore re-reads `AgentRun.output` at the given index and copies the snapshot
itself. Selection is refused for a run that is absent, owned by another
organization, or produced by another agent, all reported as absent because none
is a distinction the caller is entitled to; a run the caller *can* see but which
has not succeeded is refused as a conflict instead, since pretending it does not
exist would be a lie they can check.

The originating brief — topic, goal, and the optional audience and guidance —
is snapshotted onto the project from the run's input by the same parse that
supplies the content language. It is copied for the same reason the idea is:
the project has to be a complete statement of the work, and a writer reaching
back into `AgentRun.input` to find out what the piece is for would depend on a
JSON column belonging to another aggregate, pinned to a definition revision that
may no longer be current. A run whose input this version cannot parse is
therefore refused rather than promoted without a brief — a project that cannot
say what it is for is not worth creating.

`ContentDraft` revision 1 is created in the same statement as the project. A
project without a draft is a state no caller should observe, so the draft is not
a second write that could fail in between. Its body is null: no writer exists in
this slice, and a body seeded from the idea summary would be words nobody wrote.

A successful promotion appends one `contentProject.created` product-audit event
on the same transaction client, so the decision and its record commit or fail
together — an audit append that failed would roll the project and its draft
back, because a decision the log denies is worse for a later reader than a
creation that visibly failed. A replay appends nothing: it returns before
reaching the write. The projection is closed to identifiers and the two
code-owned enums; the caller's idempotency key, the request body, the brief, and
the agent's prose are all deliberately absent.

Tenant isolation here is a database constraint rather than a service predicate.
`content_project` references `(sourceRunId, organizationId)` against a composite
unique on `agent_run`, and `content_draft` references
`(projectId, organizationId)`, so a cross-organization selection is refused by
PostgreSQL whether or not the service check runs. The check exists to return a
clean 404 rather than a constraint violation. An `Idempotency-Key` header is
required and, as with generation, the stored key mixes it with a digest of the
request, so a retry finds its own project while the same key with a different
body is a different request.

The control plane (`src/features/control-plane/`) holds operational state an operator can
change without a deployment: feature flags, typed runtime settings, and
encrypted provider credentials. Every key is registered in code with its schema,
default and bounds, so the Platform cannot create a setting nothing reads or
store a value outside the range the application is known to behave across.

Every control-plane mutation appends an audit event in the same PostgreSQL
transaction as the mutation. Events record actor, time, resource/key,
organization scope where relevant, action, and a sensitivity-aware safe
before/after projection; resetting or removing the current value does not erase
that history. The authorized cursor-paginated read endpoint is operator-only.
Credential plaintext, ciphertext, IV, authentication tag, and any recoverable
credential material are excluded at the writer and never returned by the API.

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

The knowledge taxonomy is **code-owned**. `knowledge-space.registry.ts` declares
the eight spaces every organization has — `organization.profile`,
`brand.identity`, `brand.voice`, `audience`, `products.services`,
`content.strategy`, `design.system`, `faq` — and there is no route that defines
a ninth. That is what closes the gap the old free-form slug field left open: an
agent's `ContextPolicy` is written in code against a slug, so a customer typing
`brand-voice` where a policy expects `brand.voice` produced a policy that
retrieved nothing and reported nothing. A caller may now *select* a registered
space; the row is written on first ingestion, inside that ingestion's own
transaction. Names and descriptions come from the registry rather than from a
caller, and the Platform renders a translated name keyed on the slug.

Space listings need no paging: the registry is fixed and small, so the listing
is structurally bounded and returns all eight annotated with what this
organization has stored in each. Document listings are keyset-paged on
`(title, id)` with a server-enforced maximum page size. Offset paging would be
wrong for a collection written to while it is read — ingesting a document that
sorts early shifts every later row, so the reader repeats one and skips
another. A cursor carries a position and no authority: the query keeps its own
`organizationId` and `spaceId` predicates, so a cursor minted elsewhere can only
position over rows the caller could already read.

The Knowledge domain (`src/features/knowledge/`) holds organization-owned reference
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
work: no new revision, no chunk rewrite, and no embedding event. Correcting a
`sourceUri` on unchanged text is written on its own and the response describes
the row *after* that write — `updatedAt` carries `@updatedAt`, so answering with
the value read a moment earlier would report the timestamp of the previous
change and let a client conclude its stale copy was current. Text that has
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

`src/cli.ts` runs one command and exits. There are two: `super-admin:create`,
which creates the platform's first super administrator, and
`managed-secret:rotate-key`, which re-encrypts stored credentials under the
active encryption key version.

They have separate composition roots — `CliModule` and `RotationCliModule` — and
that separation is the design rather than an accident of layering. The two need
disjoint authority: rotation reads and rewrites every stored credential, while
bootstrap can mint an administrator account. Composing them together would hand
each one the other's reach, so the master key is loaded only where credentials
are rewritten and the authentication stack only where an account is created.
Only the command actually invoked is constructed.

That separation is an injection boundary rather than a process one, and the
distinction matters when reasoning about blast radius. Both commands run inside
the `backend` service, whose environment carries every credential that service
is given, so narrowing the graph does not empty `process.env`. What it does mean
is that the other command's *machinery* — the authentication stack, the mail
transport, the HTTP server — is never constructed, so nothing in the process is
in a position to act on what the environment happens to hold.

Rotation is bounded, resumable, and idempotent: it pages on the immutable
primary key, and commits each row through a compare-and-swap on the `updatedAt`
*and* the ciphertext it read, so a credential an operator changes mid-run is
never overwritten by a re-encryption of the value it replaced — the timestamp
alone is millisecond-granular, and the bytes being replaced are what make the
guard exact. Every row is authenticated before anything is concluded about it,
including the rows the sweep does not write: a row is called current only when it
proves it can still be opened, because the report is what an operator reads
before deleting a key and metadata cannot see an altered ciphertext. A row it
cannot decrypt is reported and left byte for byte as it was.

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
