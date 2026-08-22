# Agent run terminal reconciliation execution plan

## Goal

Close the remaining reliability gaps in the generic AgentRun infrastructure so
that no known hard blocker prevents starting the first real production agent
vertical slice.

Concretely: a terminal BullMQ failure for `agent-execution` must never leave its
`agent_run` row non-terminal forever, deterministic configuration failures must
stop consuming retry budget, and the Mastra logger containment must rest on the
strongest evidence reasonably available.

## Context

The foundation landed in
[agent-runtime-foundation](../completed/agent-runtime-foundation.md) (PR #27
merge `ca26258c0e0199f9544a5fdcddf1ad87f3a94035`, PR #28 merge
`f313f4bf97ba0b71fdfdd4eea98eaee84c6b62dc`). It left three items recorded as
known gaps rather than defects:

1. **Terminal transport reconciliation.** BullMQ can fail a job terminally
   without invoking the processor — the stalled-allowance path. The application
   therefore never records `FAILED`, and the run stays `RUNNING` indefinitely.
   The merged documentation states this is a hard prerequisite before the first
   production `AgentDefinition` or public AgentRun API.
2. **Deterministic configuration failures.** An unregistered
   `(agentId, agentVersion)` pair, a persisted runtime that disagrees with the
   definition, or an unregistered runtime cannot succeed on retry, yet they burn
   the full retry budget with exponential backoff.
3. **`Agent.__setLogger`.** Provider log containment relies on a
   private-looking SDK hook, which is an upgrade-compatibility risk.

PostgreSQL remains business authority; Redis/BullMQ remains coordination and
at-least-once transport. Those roles do not change here.

## Scope

- A durable, idempotent terminal-failure reconciliation mechanism for
  `agent-execution`, composed only in the worker process.
- The narrowest queue/application boundary needed to keep `core/queue`
  independent of `agents`.
- An application-owned classification separating deterministic non-retryable
  execution failures from retryable runtime/provider failures.
- Mastra logger containment: adopt a supported public API if one exists in the
  installed version; otherwise narrow the risk with the strongest no-network
  compatibility evidence available.
- Focused concurrency and failure-path tests, including real Redis/PostgreSQL
  integration where BullMQ semantics are the thing under test.
- Owning documentation and both execution plans.

## Non-goals

No first production `AgentDefinition`, public `POST /agent-runs`, provider
credentials, live provider calls, tools, tool-execution ledger, memory,
conversation memory, RAG, embeddings, vector store, streaming, SSE,
cancellation, resume, checkpoints, workflow engine, multi-agent orchestration,
provider abstraction framework, runtime plugin discovery, LangGraph adapter,
MCP, sandbox, eval platform, tracing platform, generic queue reconciliation
framework, generic event bus, distributed execution lease framework, or
automatic AgentRun replay/requeue.

Automatic requeue is specifically excluded. A fresh BullMQ job restarts
`attemptsStarted` at 1 while the run may hold a higher `attemptCount`, so the
monotonic fence would reject the claim. Re-running a failed run is a distinct
future operation with its own semantics.

## Constraints

- PostgreSQL is business authority; BullMQ proves transport state only.
- `core/queue` must not depend on `agents`.
- The API composition root must remain structurally incapable of consuming
  jobs or running reconciliation.
- Preserve the existing fencing rule exactly: claim on
  `attemptCount < attemptsStarted`; completion and failure writes CAS on the
  exact claimed `attemptCount`.
- Reconciliation must be idempotent, terminal-safe, and must not depend on
  in-process memory or on an ephemeral notification for correctness.
- Never persist or log BullMQ/provider raw errors, stacks, causes, response
  bodies, prompts, or request payloads. Durable diagnostics are application-owned
  constants.
- Mastra imports stay within `apps/backend/src/agents/runtime/mastra/**` and its
  tests.
- Prefer no migration. Add one only with a stated reason that is not new durable
  state.
- No provider secrets and no live provider calls.
- One focused branch and one PR against `main`. No merge, auto-merge,
  force-push, history rewrite, deployment, or environment/secret operation.

## Acceptance criteria

### Terminal reconciliation

- A `RUNNING` run whose BullMQ job reached terminal failure becomes `FAILED`
  with `completedAt` set and a safe constant `lastError`.
- A `QUEUED` run in the same situation becomes `FAILED`.
- `SUCCEEDED` and `FAILED` runs are untouched.
- Repeated and reordered observations are no-ops.
- An unknown or missing run does not crash the worker.
- Correctness survives process restart and does not depend on having observed a
  notification.
- A transient PostgreSQL failure during reconciliation is retried by a later
  pass rather than lost.
- Enumeration/lookup against Redis is bounded, not an unbounded scan.

### Deterministic failures

- An unregistered `(agentId, agentVersion)` pair, a runtime mismatch, and an
  unregistered runtime are classified as deterministic and non-retryable.
- When the delivery still owns the claim: the run becomes `FAILED` with
  `completedAt` and a safe constant, a fixed operator reason code is emitted,
  and BullMQ receives `UnrecoverableError` carrying only a safe constant.
- When the finalizing CAS fails because a newer delivery owns the run: nothing
  is overwritten, and the stale delivery does not terminally fail the job on the
  newer owner's behalf.
- Transient runtime/provider failures keep the existing retry budget and
  behavior.

### Mastra containment

- Either a supported public API replaces `__setLogger`, or the existing
  containment is retained with recorded evidence and the strongest feasible
  no-network compatibility coverage against the real installed SDK.
- No provider request, provider package, or API key is required by any test.

### Invariants preserved

Existing idempotency, version pinning, skipped-ordinal claiming, terminal
guards, and lost-claim behavior all remain green.

## Validation

Focused checks while iterating, then the required aggregate set:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend prisma:validate
pnpm --filter backend prisma:generate
git diff --exit-code -- apps/backend/src/generated/prisma
pnpm --filter backend test:e2e
pnpm build
ops/tests/documentation.sh
git diff --check
```

E2E requires the test services (`pnpm db:up` equivalents for the `test`
profile). CI on the final head must be green.

## Required evidence

- Installed-source citations for every BullMQ and Mastra behavioral claim.
- Focused test output demonstrating each acceptance criterion, including a test
  that fails against the pre-change behavior.
- Aggregate local validation output and the final-head GitHub Actions result.
- Code-review, security-review, and test-engineer findings with remediations.
- PR URL, base, head, and explicit untouched-environment confirmations.

## Git / PR policy

- Branch `feat/agent-run-terminal-reconciliation`, base `main`.
- One focused PR, left open and unmerged for human review. Merging to `main`
  deploys live Staging and is a human decision.
- Stage explicit reviewed paths only. Never force-push or rewrite history.

## Decision log

- 2026-08-22: Opened this plan and moved
  [agent-runtime-foundation](../completed/agent-runtime-foundation.md) to
  `completed/` with its landing evidence. The previous plan had remained under
  `active/` after its work merged, which is exactly the false active state the
  execution-plan convention forbids.

## Progress

- [x] Intake: harness, policies, workflow, and the completed plan's deferred
  items reviewed.
- [ ] Discovery: BullMQ terminal-failure semantics, Mastra logger API, and
  existing scheduling/test infrastructure.
- [ ] Design.
- [ ] Implementation.
- [ ] Focused and aggregate validation.
- [ ] Code, security, and test reviews.
- [ ] PR opened with green final-head CI.

## Blockers

None currently.
