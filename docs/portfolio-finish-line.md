# Portfolio finish line

This is the current program policy: what this repository has already proven,
what remains before it is feature complete, and what is explicitly not required.
[ADR 0002](decisions/0002-portfolio-finish-line.md) records why the program is
bounded this way. This document records what is left.

The project's mode is Portfolio / Engineering Demonstration. Work is prioritized
by one test:

> **Does this work prove a meaningful engineering capability that this
> repository does not already demonstrate?**

Roadmap completion is not a goal. An older roadmap entry is not authorization
to propose work, and it does not become one by age.

This policy and the harness govern different things, and both apply:

- **The harness controls whether work may start.** The PR-train approval
  boundary in [the PR train workflow](../.agents/workflows/pr-train.md) requires
  `## [APPROVED] <task id>` with `Approved to start: [x]`; an unchecked box, a
  bare roadmap entry, or a task absent from the window is not approval, and a
  missing window fails closed.
- **This document controls what work should be proposed and prioritized.** That
  is judgment about the project's purpose, which no checkbox expresses.

## Already sufficiently demonstrated

These capabilities are implemented, tested, and inspectable in the repository
today. [`docs/feature-inventory.md`](feature-inventory.md) is the detailed
inventory with per-capability source references; this list is the summary that
matters for portfolio judgment.

**Multi-tenancy and authorization**

- Organization-scoped isolation enforced in the schema: where one
  organization-owned row references another, the foreign key is the composite
  `(id, organizationId)` pair against a matching unique constraint, so a
  cross-tenant reference is refused by PostgreSQL rather than by a service
  predicate.
- Two separate RBAC domains — platform (`user`, `admin`, `super_admin`) and
  organization (`member`, `admin`, `owner`) — with backend enforcement
  authoritative and client gates treated as UX only.
- Append-only organization product audit with a closed action vocabulary and a
  closed projection, with deletion refused by the database.
- Negative tenant and security tests, including direct-SQL probes that assert
  the database itself refuses cross-organization writes.

**Agent engineering**

- `AgentRuntime` as an application boundary with a Mastra adapter behind it, so
  the runtime is replaceable without touching the domain.
- Code-owned agent definitions with version pinning; runs are pinned to the
  exact definition and to an immutable, tenant-bound organization-agent version.
- Model, policy, and pricing resolution pinned onto the accepted run.
- Durable `AgentRun` acceptance, duplicate-safe background execution,
  Zod-validated configuration/input/output, and deterministic configuration
  failures recorded as final rather than retried forever.
- `content-idea@1` as a real production agent, grounded in the organization's
  own knowledge spaces.
- Knowledge/RAG: organization-owned spaces, documents, and pgvector-embedded
  chunks retrieved by cosine search scoped inside the ranking query, with
  content-addressed ingestion that revises only on real text change.
- The ContentProject selection slice: a selected idea promoted into a durable
  project with its originating brief and an initial draft revision, written in
  one transaction with its audit event.

**Distributed-systems discipline**

- PostgreSQL is authoritative business state; Redis is disposable coordination.
- Transactional outbox: accepted async work is committed with its event before
  any queue publish.
- At-least-once delivery with idempotency at two distinct layers: request
  idempotency at the API boundary, where a caller key composed with a body
  digest is read in-transaction, inserted, and the winner re-read on conflict;
  and consumer idempotency as a PostgreSQL unique constraint on the business
  row, since a BullMQ dedupe key only collapses duplicates while the job is
  still retained in Redis.
- BullMQ coordination with deduplication, lease/retry, claim-version fencing,
  and reconciliation of terminal transport failures to a durable outcome.
- API, worker, and migration as separate composition and execution modes.

**Security and operations**

- Managed provider credentials encrypted with AES-256-GCM, a versioned keyring,
  and resumable idempotent master-key rotation; no read surface returns a value.
- Runtime secrets owned by the host, never by the repository.
- CI, immutable multi-image publishing, migration-gated automatic Staging
  delivery from exact publisher evidence, container topology, rollback from
  exact release manifests, and verified backup with an isolated restore drill.
- Structured logging, request IDs, liveness/readiness, and graceful shutdown.

**Real defects should still be fixed.** This list is not a freeze. What it rules
out is manufacturing hardening work — additional sweeps, additional negative
tests, additional abstraction layers — merely to increase coverage against
capabilities that are already proven.

## Portfolio feature-complete exit criteria

The project is **feature complete** when all of the following hold:

- [x] Governed code-owned Tool Registry
- [x] One real read-only tool
- [x] Durable `ToolExecution` in PostgreSQL
- [x] Tenant, grant, and schema enforcement
- [x] One safe idempotent side-effecting tool/action
- [x] Retry without duplicate external effect
- [x] One Human Approval flow
- [x] Preconditions revalidated before execution
- [ ] MCP adapter through the same application Tool Gateway
- [ ] Lightweight execution visibility
- [ ] One realistic integrated vertical slice
- [ ] Current architecture, docs, and demo
- [ ] Green CI
- [ ] Stable portfolio release

After these are satisfied: **FEATURE COMPLETE.** Feature development stops
unless a new explicit human decision changes the goal.

## Bounded roadmap

Three slices remain; TOOL-01 is delivered and ACT-01 is implemented on its
branch. PORT-PLAN-01 — the roadmap reset — was governance, not a technical
capability, and is not counted among them.

Gate P1 closes when ACT-01 is merged and delivered to Staging; the checked
criteria above describe the code on the ACT-01 branch, not what `main` proves
until that merge.

### TOOL-01 — Governed durable tool execution — **delivered**

Code-owned tool registry with identity, schema, and risk classification;
organization grants subsetting definition maxima; `knowledge.search@1` as the
first real read-only tool; durable `ToolExecution` records in PostgreSQL. See
[the backend's governed tool execution section](backend.md).

### ACT-01 — Human approval and idempotent side effect — **implemented, pending merge**

One side-effecting action, and only one: `notification.send@1`, proposal-only.
A separate tenant-safe approval row, compare-and-set decisions committed with
their audit and outbox rows, every mutable precondition re-read in the worker
immediately before the provider call, a stable provider idempotency key derived
from the execution, and an honest `OUTCOME_UNKNOWN` for a lost response. See
[the backend's human-approval section](backend.md#human-approval-and-the-idempotent-side-effect).

### MCP-01 — MCP adapter over the Tool Gateway

Model Context Protocol as an adapter behind the existing application Tool
Gateway, subject to the same governance, grants, and approval controls. MCP is
an adapter, not a second backend.

### DEMO-01 — Integrated vertical slice and execution inspector

One complete, demonstrable path: agent run → tool call → approval → durable
side effect → audit event, with a lightweight organization-scoped inspector that
leaks no secrets.

### PORT-01 — Portfolio closeout

README, architecture diagrams, demo flow, setup instructions, tradeoffs,
limitations, screenshots where useful, and a stable release tag.

### Then stop.

## Program gates

**Gate P0 — Roadmap reset.** After PORT-PLAN-01: all authoritative documentation
agrees that the project is in bounded portfolio-completion mode.

**Gate P1 — Tool/action core.** After TOOL-01 and ACT-01: durable tools, side
effects, retry idempotency, and human-in-the-loop are genuinely proven. Do not
add further infrastructure unless MCP-01 or DEMO-01 actually requires it.

**Gate P2 — Portfolio exit.** After DEMO-01: if the integrated slice is
demonstrable and the invariants are inspectable, only PORT-01 remains. Do not
open another product milestone.

## Future ideas — not completion requirements

These are not required for feature completeness and are not deferred
obligations:

- Writer Agent and content production pipeline
- Brand system
- Object storage, file upload, and PDF/document ingestion, unless the final demo
  actually demands it
- URL and web research
- Storyboard, carousel, and image generation
- Social publishing and content calendars
- WhatsApp, Instagram, and Facebook channels
- Contacts, conversations, and messaging platforms
- Stripe, billing, and credits
- A broad usage ledger
- Analytics, GA4, and Search Console
- A generalized workflow engine or scheduler
- A plugin marketplace
- A second large runtime adapter
- Broad generic hardening sweeps

None of these are forbidden forever. Each requires a **new explicit human
decision** and independent engineering justification after portfolio completion.
