# Human approval and one idempotent external side effect

## Goal

Deliver ACT-01: exactly one governed side-effecting tool, `notification.send@1`,
that a model may *propose* but never perform. The application records the
proposal durably, requires an authorized human decision, revalidates every
mutable precondition immediately before the effect, delivers through the
existing PostgreSQL → outbox → BullMQ → worker path, and uses a stable
provider idempotency identity so a retried delivery causes no duplicate
external effect. Together with TOOL-01 this closes Gate P1 once merged.

## Context

TOOL-01 delivered the code-owned tool registry, exact-version organization
grants pinned to the accepted run, the application-owned `ToolGateway`, and a
durable `ToolExecution` whose lifecycle is `STARTED -> SUCCEEDED | FAILED`. It
deliberately refused to compose a `side_effect` tool: nothing in that build
could make an external effect idempotent, revalidate a precondition, or ask a
human. This slice is the change that relaxes that refusal, and the discovery
that shaped it:

- `MailService.dispatch` is fire-and-forget by design for auth mail, where a
  duplicate is tolerable. It is not reused for the governed effect.
- The installed `resend@6.20.0` accepts `{ idempotencyKey }` as the second
  argument of `emails.send` and sets the `Idempotency-Key` header. Resend keeps
  a key for 24 hours; the same key with the same payload replays the original
  response and email id without sending again; the same key with a different
  payload is `409 invalid_idempotent_request`; a concurrent in-flight duplicate
  is `409 concurrent_idempotent_requests`; a malformed key is
  `400 invalid_idempotency_key`. Keys are at most 256 characters.
- Organization membership is `Member (organizationId, userId, role)` with the
  recipient's deliverable state on `User (email, deletedAt, banned)`.
- The outbox route table is code (`OUTBOX_EVENT_ROUTES`), the worker registers
  handlers explicitly, and BullMQ retries are bounded by `QUEUE_JOB_ATTEMPTS`.

## Scope

- `notification.send@1` (`runtimeName` `notification_send_v1`), `side_effect`,
  strict input `{ recipientMemberId, subject, body }`, output
  `{ status: 'awaiting_approval' }`. The model supplies nothing else.
- `ToolExecution` gains the side-effect lifecycle
  `AWAITING_APPROVAL -> REJECTED | APPROVED -> SUCCEEDED | FAILED | OUTCOME_UNKNOWN`
  and effect bookkeeping (`effectAttemptCount`, `effectFirstAttemptedAt`,
  `effectPayloadDigest`, `providerMessageId`), plus `@@unique([id, organizationId])`.
- One `ToolExecutionApproval` row per side-effect execution, tenant-safe through
  the composite `(toolExecutionId, organizationId)` foreign key, holding
  `PENDING | APPROVED | REJECTED`, who decided, when, a bounded note, and the
  digest of the proposal it decided on.
- Organization permission `agentActionApproval: ['read', 'decide']`. `member`
  reads; `admin` and `owner` decide. Enforced by the existing organization guard.
- HTTP: list / detail / approve / reject under
  `organizations/:organizationId/agent-action-approvals`.
- Approval and rejection are compare-and-set transitions committed in one
  transaction with the audit event and, for approval, the
  `tool-execution.approved` outbox event.
- `SideEffectExecutionHandler` in the worker: terminal no-op, generic
  revalidation, tool-specific revalidation, fenced attempt claim, provider call
  with the stable key `${toolId}@${toolVersion}:${toolExecutionId}`, honest
  terminal outcome.
- `NOTIFICATION_DELIVERY` port: Resend adapter with the provider idempotency
  key, log adapter for development, and an explicit `unsupported` answer for
  drivers without an idempotency guarantee.
- Closed audit actions `agentActionApproval.approved` and
  `agentActionApproval.rejected`.
- Platform: an Approvals tab listing pending and decided proposals with
  approve/reject gated by `agentActionApproval:decide`.

## Non-goals

No generic workflow or approval engine, approval chains, quorum, or reusable
definitions. No second queue system or message bus. No notification center or
inbox product. No arbitrary email recipients. No change to auth mail semantics.
No MCP, no demo agent, no inspector — those are MCP-01 and DEMO-01.

## Constraints

- The model may name the tool and supply its input, nothing else. Organization,
  run, version, recipient email, provider, credential, sender, idempotency key,
  approval actor and execution id all come from application state.
- Approval is not permanent authority. Every mutable precondition is re-read
  immediately before the provider call, and a proposal whose payload digest no
  longer matches the approved one never sends.
- Every state transition is a compare-and-set with an exact expected row count;
  races fail closed.
- Retry uses the same key and the same effective payload. Exactly-once is not
  claimed. When the provider may have accepted a request whose outcome was lost
  and the safe window has passed, the execution is `OUTCOME_UNKNOWN`, never
  `FAILED`.
- No provider error, header, cause, credential, or key reaches `ToolExecution`,
  audit, logs, the API, or the model transcript.
- Additive, forward-only migration; rollback-compatible with the preceding image.

## Acceptance criteria

- [x] `notification.send@1` composes as a `side_effect` tool; `knowledge.search@1`
      and `content-idea@1` are unchanged
- [x] A side-effect call writes `AWAITING_APPROVAL` plus one `PENDING` approval
      in one transaction and performs no external effect
- [x] Authorization: member cannot decide; admin and owner can; outsider,
      platform admin without membership, and wrong organization are refused
- [x] Exactly one approval per execution; approve/approve and approve/reject
      races leave exactly one decision
- [x] A rejected proposal never executes; nothing executes before approval
- [x] Revalidation refuses: recipient removed, recipient in another tenant,
      organization archived, grant mismatch, payload mismatch
- [x] Duplicate and concurrent deliveries produce one provider effect with one key
- [x] Ambiguous outcome is recorded honestly and never retried past the window
- [x] Provider errors, headers and keys are contained everywhere
- [x] PostgreSQL refuses a cross-organization approval reference
- [x] Approval decisions are audited with a closed projection

## Validation

`pnpm agents:check` · `pnpm typecheck` · `pnpm lint` · `pnpm test` ·
`pnpm --filter backend test:e2e` · `pnpm build` · `ops/tests/documentation.sh` ·
`git diff --check` · `prisma validate` · `prisma generate` (idempotent) ·
migrations from zero · `migrate diff` = zero · rollback compatibility.

## Required evidence

Focused test output for authorization, approval transitions, revalidation,
idempotency, unknown outcome, containment and tenancy; migration-from-zero and
zero-drift output; specialist review findings and their remediation.

## Decision log

- **A separate approval table rather than columns on `ToolExecution`.** The
  decision is a different fact from the execution: it has its own actor, its
  own time, and its own digest of what was decided. Its composite foreign key
  is what lets PostgreSQL refuse a cross-tenant approval.
- **The effect attempt counter is the concurrency fence.** A delivery claims by
  `effectAttemptCount = seen` and bumps it; a losing delivery rejects and lets
  BullMQ retry, by which time the row is terminal or reclaimable. No lease
  column and no lock held across the provider call.
- **The payload digest is stored on first attempt, not the payload.** Retry
  must reuse the same effective payload; comparing digests proves it without
  persisting the recipient's address.
- **Drivers without provider idempotency are `unsupported`, not best-effort.**
  SES and SMTP cannot honour the retry guarantee, so the effect fails closed
  before any send rather than pretending.

## Review outcomes

Three specialist reviews ran; none found a blocking defect, and two found the
same class of dishonesty from different directions.

**A refusal after an ambiguous attempt was recorded as `FAILED` (code review,
high; security review, medium).** Revalidation ran before the attempt-count
check, so a recipient who left between a timed-out first attempt and the
retry settled `FAILED` — a claim that nothing was sent, which the first attempt
made unknowable. Independently, the Resend adapter classified
`invalid_idempotent_request` as `rejected`, and that code is returned only
when an *earlier* request with the same key was accepted. Both now resolve
through one rule: once any attempt has been claimed, every refusal settles
`OUTCOME_UNKNOWN`, and `FAILED` is reserved for a refusal before the first
provider call. The payload digest also gained the sender and the rendered HTML,
so a deploy-time change to either is caught before the provider sees it.

**The worker could not boot under `ses` or `smtp` (code review, high).**
`workerConfigurations` gained `mailConfig`, whose driver schemas require
`AWS_REGION` or `SMTP_HOST`, and the compose allowlist withheld them. The
non-secret discriminators are now passed and asserted; the credentials stay
withheld, and a composition test proves both drivers compose and answer that
they cannot be idempotent.

**Stranded `APPROVED` rows (both reviews, medium/low).** A tool fault on the
last attempt now settles rather than rethrowing, and the residual case — a
process death between the provider call and the settlement, past the stalled
allowance — is documented in the outbox document and the runbook rather than
swept by a reconciler that could not be honest.

Smaller findings remediated: every database call in the handler is contained
to the constant; the handler's log vocabulary and the row and view status
fields are closed unions rather than strings; comments that overclaimed mutual
exclusion of the provider call were corrected; the Platform's load-more drops a
page that arrives after the filter changed; two dead exports removed.

## Progress

- [x] Discovery
- [x] Execution plan committed
- [x] Schema and migration
- [x] Tool definition and gateway proposal path
- [x] Approval service, controller, authorization, audit
- [x] Delivery port and side-effect worker
- [x] Platform approval surface
- [x] Tests
- [x] Documentation
- [x] Specialist reviews and remediation
- [x] Aggregate validation
- [x] PR opened; final-head CI recorded on the PR

## Blockers

None.

## Verified evidence

- `pnpm agents:check` — passed, 113 harness tests.
- `pnpm typecheck`, `pnpm lint` — clean, no `--fix` in verification.
- `pnpm test` — backend 1476 (six new specs), platform 877, web 2 files.
- Backend e2e — 33 suites; the new approval suite 44/44 against the real
  database; the full run 723/724 with the one failure being the carried
  `outbox.e2e-spec.ts` "honours the batch limit" observation (see below).
- `prisma validate`; `prisma generate` idempotent; migrations from zero on a
  fresh database; `migrate diff` exit 0; rollback compatibility executed as a
  test — the preceding image's column-omitting `INSERT` is accepted with the
  defaults meaning "no effect attempted".
- Cross-tenant `tool_execution_approval` insert refused by
  `tool_execution_approval_toolExecutionId_organizationId_fkey` with a
  positive control.
- Resend semantics read from the installed SDK and the provider's
  documentation, not assumed: key ≤ 256 characters, 24-hour window,
  same-payload replay, `409 invalid_idempotent_request` on a changed payload,
  `409 concurrent_idempotent_requests` on a concurrent duplicate.

**The carried outbox observation recurred once**, in one of four full or
focused runs, and this branch changes nothing in `OutboxRepository.claim`.
The failing assertion received five claimed rows for `LIMIT 2`, all with
`attempts = 1`, which is the signature of the `LIMIT ... FOR UPDATE SKIP
LOCKED` subquery inside `WHERE id IN (...)` being evaluated more than once by a
planner that chose a nested plan — a plan choice that depends on table
statistics and therefore on what earlier suites left behind. `EXPLAIN
ANALYZE` on the same database afterwards showed a hash semi-join evaluating
the subquery once and returning two rows. The over-claim is a batch-size
violation, not a delivery or idempotency defect. It is recorded as a confirmed
pre-existing non-blocking finding with a candidate fix — materialize the
candidate selection in a CTE so the limit is applied exactly once — for a
separate maintenance change rather than widened into this slice.

## Outcome

Delivered on `feat/approval-side-effect`, based on `main` at
`eead84a8d34ba7440f10135a6d4101c4d85ce2bd`, first of the four-slot train
ACT → MCP → DEMO → PORT. Together with TOOL-01 it satisfies the eight tool and
action exit criteria; Gate P1 closes when the merge has deployed to Staging.
