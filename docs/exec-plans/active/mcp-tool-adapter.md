# MCP as an adapter over the governed tool gateway

## Goal

Expose the tools an organization has already granted an installed agent to an
external MCP client, through the same `ToolGateway` that Mastra runs behind,
without introducing a second registry, a second grant model, a second
`ToolExecution` path, a second approval implementation, or a second credential
system.

The load-bearing claim this slice must prove is negative: an MCP client holding
a valid session **cannot** send a notification. It can only propose one, and a
human still decides.

## Context

TOOL-01 put every decision about what an agent may do behind `ToolGateway`.
`authorize()` intersects the code-owned `AgentDefinition.maxToolGrants` with the
run's immutable `OrganizationAgentVersion.toolGrants` and returns
`AgentRuntimeTool[]` — a name, a description, two Zod schemas and a closure
already bound to one run in one organization. The runtime never receives the
gateway, the registry, Prisma, or grant state, so an adapter has no way to
*express* an authority decision.

ACT-01 then made one tool a `side_effect`. A side-effect call through the
gateway writes an `AWAITING_APPROVAL` `ToolExecution` and a `PENDING`
`ToolExecutionApproval` and returns `{ status: 'awaiting_approval' }`. The
provider call happens later, in the worker, after a human decision, after every
mutable precondition is read again.

That shape is why MCP is a small change. `AgentRuntimeTool` maps one-to-one onto
the MCP SDK's `registerTool`, and the approval requirement is inherited rather
than reimplemented — an MCP caller reaches `notification.send@1` through the
same closure Mastra would, so it reaches the same proposal.

The one genuinely new question is context binding. `ToolExecution` requires
`(agentRunId, organizationId)`, and that composite FK is the tenant boundary;
making `agentRunId` nullable to accommodate MCP would delete the boundary to
make an adapter convenient. So an MCP session must *be* an `AgentRun`.

## Scope

### The session is an AgentRun driven by an external MCP client

`AgentRun` already means "a bounded period of agent activity in one
organization, pinned to one definition revision and one immutable grant set,
initiated by one user". An MCP session is exactly that; the only difference is
who drives it. So the session needs no new table and no new column.

- `AgentRun.runtime` carries `MCP_SESSION_RUNTIME = 'mcp'`. `AGENT_RUNTIME_NAMES`
  is left alone: it types `AgentDefinition.runtime`, the set of runtimes that
  can *execute* a definition, and no definition is executed by an MCP client.
- `AgentRuntimeRegistry.resolve('mcp')` therefore throws. That is the fail-closed
  guarantee, not an oversight: even if a job for an MCP session were somehow
  published, the worker could not execute it.
- No outbox event is appended, so no job exists in the first place.
- Accepted as `RUNNING` with `startedAt` set and `attemptCount = 1`.

Acceptance reuses `AgentRunService.create` rather than a parallel write path,
via one explicit input field (`driver: 'worker' | 'mcp_client'`, default
`'worker'`). That keeps the per-organization advisory lock, the exact in-flight
ceiling, durable idempotency, installation resolution, definition-revision
pinning and organization-version pinning in one place. A second acceptance path
would be a second set of answers to all of those.

### Session lifetime is bounded and terminal

- Absolute TTL from `createdAt`: `MCP_SESSION_TTL_MS` (60 minutes). Deliberately
  not sliding — an absolute bound is what makes the worst case a number.
- `DELETE` closes it: `SUCCEEDED`, `output = { closedBy: 'client' }`.
- An expired session that is touched is closed (`closedBy: 'expiry'`) and the
  request is refused.
- An expired session nobody touches is closed by `AgentRunReconciler`. Without
  this it would sit `RUNNING` forever — a durable lie, and one the DEMO-01
  inspector would display — while being logged as a missing transport record on
  every sweep. One branch on `runtime` fixes both.
- Closing is a compare-and-set on `(id, organizationId, runtime, status)`, so a
  concurrent close and expiry cannot both write an outcome.

### Session capacity and cost are bounded

- Session creation passes the operator's existing
  `agents.max_concurrent_runs_per_organization`, because a session is in-flight
  agent activity that spends the platform's provider credential. A session
  therefore holds a slot until it is closed or expires; that is the honest
  tradeoff of modelling it as a run, and it is recorded in the docs.
- `MAX_TOOL_INVOCATIONS_PER_ATTEMPT` does **not** transfer. The gateway captures
  that budget inside one `authorize()` call, and the adapter authorizes once per
  HTTP request, so an MCP client would get a fresh budget every request — an
  unbounded number of paid embedding calls per session. The adapter therefore
  enforces a durable per-session ceiling, `MCP_SESSION_TOOL_CALL_BUDGET`, by
  counting the session's `ToolExecution` rows before delegating a call.
  Concurrent requests can overshoot it by at most the number of requests in
  flight; that is stated rather than hidden.
- The MCP endpoint is metered per user with the existing `UserRateLimit`.

### Protocol facts this design depends on

Verified against the installed `@modelcontextprotocol/server@2.0.0` and
`@modelcontextprotocol/client@2.0.0` type definitions and runtime, and against
specification revision 2026-07-28. Recorded because several are the inverse of
the v1 SDK and a reader working from memory would get them wrong.

- `createMcpHandler(factory, options)` returns `{ fetch, close, notify, bus }`.
  `fetch(request, { authInfo?, parsedBody? })` accepts a pre-parsed body, which
  is what lets a Nest controller hand it `@Body()` instead of re-reading a
  stream the framework already consumed.
- The factory runs **once per HTTP request** with `{ era, authInfo?, requestInfo? }`.
  That is what makes a per-request authorized tool set the supported shape
  rather than a workaround, and `tools/list` is derived from the instance's own
  registration map.
- Full `z.object()` schemas are the preferred form for `inputSchema` and
  `outputSchema`; the raw-shape form is `@deprecated` in v2, the inverse of v1.
  A tool with an `inputSchema` receives `(args, ctx)`; one without receives
  `(ctx)` alone.
- With an `outputSchema` declared, the SDK requires and validates
  `structuredContent`, and skips that validation entirely for an `isError`
  result.
- Error semantics, which the tests must assert exactly: an **unknown tool name**
  is a JSON-RPC `-32602`, thrown before the handler's catch. **Input validation
  failure, a throwing callback, and output validation failure are all
  `{ isError: true }` tool results**, not protocol errors. Asserting `-32602`
  for bad arguments — correct under v1 — fails under v2.
- The SDK performs **no** token verification; `authInfo` is strictly
  pass-through and is never derived from headers. Authorization is `OPTIONAL`
  in the specification, and an HTTP transport only `SHOULD` conform *when
  supported*. This is the citation behind not building a credential product.
- The specification does make one transport requirement unconditional: a
  streamable-HTTP server **MUST** validate the `Origin` header.
  `createMcpHandler` is deliberately validation-free and expects the caller to
  do it, so this adapter does — against the existing
  `BETTER_AUTH_TRUSTED_ORIGINS`. A request with no `Origin` (a non-browser MCP
  client) is allowed; a request carrying an untrusted one is refused. No new
  configuration.
- `legacy` is `'stateless' | 'reject'` only. Under the default `'stateless'`,
  GET and DELETE on the MCP endpoint are answered `405`, and protocol-level
  sessions, the GET stream, and `initialize` are gone from the modern era.
- The v2 `Client` defaults to `versionNegotiation: 'legacy'`, so a test that
  wants the modern path must opt in explicitly.
- `StreamableHTTPClientTransport` accepts a custom `fetch`, typed
  `(url: string | URL, init?) => Promise<Response>`, so an in-process protocol
  test needs a one-line adapter to the handler's `Request`-taking `fetch`.
- `InMemoryTransport.createLinkedPair()` drives an `McpServer` directly and
  therefore does **not** exercise the HTTP entry, its classification, or origin
  validation. Both seams are used, for different claims.

### HTTP surface

Three routes under `organizations/:organizationId/mcp-sessions`, behind the
existing `OrganizationPermissionGuard`, which runs before body validation and
authorizes the organization in the path:

- `POST /` — open a session for an installed, enabled agent. Requires an
  `Idempotency-Key` header, bound to the payload exactly as the content-idea
  route does. Returns `{ runId, expiresAt }`.
- `POST /:runId/mcp` — the MCP JSON-RPC endpoint.
- `DELETE /:runId` — close the session.

A new organization permission `mcpSession: ['create']` is granted to `admin` and
`owner`, not to `member`: opening a session hands an external client the
organization's granted tools, which is administration rather than membership.

Every session route additionally requires `run.createdByUserId` to equal the
authenticated user. A session belongs to whoever opened it, so reconnecting — or
another admin discovering the id — manufactures no authority. The response
deliberately carries no endpoint URL: the server does not reliably know its own
public prefix, and inventing one would be a configuration dependency for no
gain. The path shape is documented instead.

### Per-request authority, nothing cached

Every MCP request re-derives everything:

1. Load the run under `{ id, organizationId, runtime: 'mcp' }`.
2. Require `RUNNING`, unexpired, and created by the authenticated user.
3. `definitions.resolve(run.agentId, run.agentVersion)` — the pinned revision.
4. `runs.pinnedVersionFor(run)` — the pinned grants; throws on durable drift.
5. `gateway.authorize(...)` with `agentRunAttempt: 1`.
6. Build a fresh `McpServer` and `registerTool` exactly the authorized closures.

The MCP SDK's server factory runs once per request, which is what makes a
per-request authorized tool set the supported shape rather than a workaround.
`tools/list` is therefore exactly the effective grant set, and a grant changed
after acceptance does not alter this run, because step 4 reads the pinned
immutable version rather than the installation's current one.

### Containment

A tool failure arrives as `ToolExecutionFailure`, whose message is a constant
sentence naming only the tool's audited `runtimeName`. That message, and nothing
else, becomes an `isError` tool result. An unknown tool name fails closed in the
SDK as a protocol error. No provider text, SDK object, stack, Prisma message or
row content crosses the boundary.

## Non-goals

- No PAT, API-key, or OAuth authorization server. The current specification
  makes authorization optional for an MCP server, and this endpoint sits inside
  an application that already authenticates users and authorizes organizations.
  Inventing a credential product here would be a second authentication system.
- No second tool registry, gateway, grant model, `ToolExecution` writer, or
  approval implementation.
- No dynamic or runtime-registered tools, no plugin discovery, no marketplace.
- No MCP resources, prompts, sampling, or elicitation.
- No SSE transport and no sessionful legacy transport.
- No new Prisma table or column, and no schema migration.
- No product agent definition. `content-project-handoff@1` is DEMO-01's; this
  slice proves the adapter with test-only definitions, exactly as TOOL-01 and
  ACT-01 did.
- No Platform UI. The execution inspector is DEMO-01's.
- No generic workflow engine.

## Constraints

- PostgreSQL is authoritative; the session's truth is its `AgentRun` row.
- The composite `(agentRunId, organizationId)` FK stays non-nullable.
- Platform and organization RBAC remain separate domains.
- Client gates are UX; backend authorization is decisive.
- Migrations are forward-only — and this slice adds none.
- Never expose secrets, provider text, or environment values.
- No `--fix` in verification.

## Acceptance criteria

- An MCP client reaches `tools/list` and sees exactly the tools the run's pinned
  `OrganizationAgentVersion` granted, with schemas from the application-owned
  `ToolDefinition`s.
- A granted `knowledge.search@1` call succeeds through the real gateway and
  writes a `SUCCEEDED` `ToolExecution` for the session's run.
- Knowledge results never cross a tenant boundary.
- An ungranted tool is absent from `tools/list` and fails closed when named.
- An unknown tool name fails closed.
- A wrong definition revision fails closed.
- No tool argument can select an organization, run, version, grant, provider, or
  recipient address.
- `notification.send@1` through MCP writes an `AWAITING_APPROVAL` `ToolExecution`
  and a `PENDING` approval, returns `{ status: 'awaiting_approval' }`, and calls
  no provider.
- A rejected proposal never calls a provider.
- An approved proposal is delivered by the *same* ACT-01 worker path, with the
  same idempotency key derivation.
- A closed or expired session refuses every MCP request.
- A session cannot be used by anyone but the member who opened it.
- A cross-organization session id is not found.
- A member without `mcpSession: ['create']` is refused.
- A request carrying an untrusted `Origin` is refused; one carrying none is not.
- The per-session tool-call ceiling is enforced across requests.
- There is exactly one `ToolExecution` writer in the codebase.

## Validation

Focused specs first, then `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm --filter backend test:e2e`, `pnpm build`,
`ops/tests/documentation.sh`, and `git diff --check`. No schema change, so the
Prisma migration matrix does not apply; `prisma validate` still runs because the
schema file is read by the generated client.

## Required evidence

- Protocol-level proof through the real MCP client SDK, not a hand-rolled
  JSON-RPC body.
- HTTP-level proof through the real controller, guard, and session lifecycle.
- A negative cross-tenant test for every organization-scoped boundary added.
- Proof that approval cannot be bypassed through MCP.
- Reviews: security, test-engineer, code, docs-researcher.

## Decision log

- **An MCP session is an `AgentRun`, not a new entity.** `ToolExecution` requires
  a run in the same organization, and that FK is the tenant boundary. The
  alternative — nullable tenant authority — would weaken a durable invariant to
  suit an adapter.
- **`runtime: 'mcp'` rather than a new `AGENT_RUNTIME_NAMES` member.** The
  registry's job is to resolve an executable runtime. Adding `'mcp'` there would
  let a definition declare a runtime nothing can execute; leaving it out makes
  `resolve('mcp')` throw, which is the property worth having.
- **`create` gains a driver field rather than a sibling method.** The advisory
  lock, exact capacity check, idempotency and pinning are subtle and already
  correct in one place.
- **Absolute TTL, not sliding.** A sliding window makes the worst-case session
  lifetime unbounded.
- **The reconciler closes expired sessions.** Its existing job is finalizing runs
  nothing else will finalize, and excluding MCP runs instead would leak
  permanently `RUNNING` rows.
- **A durable per-session tool-call ceiling.** The gateway's in-memory budget is
  per `authorize()` call and does not survive the request boundary that MCP
  introduces.
- **No new credential system.** Authorization is `OPTIONAL` in the current MCP
  specification and the SDK verifies nothing itself, so the existing
  authenticated session plus the organization guard is decisive. The honest
  consequence — a desktop MCP client that cannot present the application's
  session cookie cannot use this endpoint — is a documented limitation rather
  than a reason to build an authorization server.
- **`Origin` is validated against `BETTER_AUTH_TRUSTED_ORIGINS`.** The
  specification requires it unconditionally and the SDK leaves it to the
  caller. Reusing the existing trusted-origin list adds no configuration, and
  absence of the header is allowed because a non-browser client sends none.

## Progress

- [x] Recovery and reconciliation after an interrupted session
- [x] Discovery: SDK and application constraints re-derived from source
- [ ] Design committed
- [ ] Implementation
- [ ] Focused tests
- [ ] Aggregate validation
- [ ] Specialist reviews and remediation
- [ ] Docs synchronized
- [ ] PR open with final-head CI green

## Blockers

None.
