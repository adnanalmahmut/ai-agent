# Adopt the bounded portfolio finish line

## Goal

Convert this repository's governing program from an open-ended SaaS product
roadmap into a bounded Portfolio / Engineering Demonstration program with an
explicit, checkable stop condition.

PORT-PLAN-01 changes only what the repository *says it is for*. It changes no
executable behavior.

## Context

The repository has accumulated a long roadmap describing a multi-channel
content SaaS: writer pipelines, brand systems, social publishing, messaging
integrations, billing, analytics, and a generalized workflow engine. That
roadmap was written when the project's purpose was open-ended.

The purpose is now bounded. The project exists to demonstrate backend
production engineering and AI agent engineering to a depth that is inspectable
by a reader, and then to stop. Under that purpose the old roadmap is not merely
long — it is actively misleading, because it presents horizontal product
breadth as outstanding obligation. An agent resuming work from it would keep
building features that prove nothing the repository does not already prove.

The old roadmap did not bypass any execution gate. The PR-train approval
boundary requires `## [APPROVED] <task id>` with `Approved to start: [x]`, treats
an unchecked box or a bare roadmap entry as not approval, and fails closed when
the window is missing or unreadable. HARNESS-01 owns that and continues to.

The problem was narrower and real: the roadmap persisted as a stale planning
signal that every resuming session had to read and re-dismiss, and a planner
reading a long backlog proposes from it. So the reset belongs on the planning
surface — an ADR for the durable decision, a current-state document for what
remains, and a short rule in `AGENTS.md` so a future agent meets the constraint
before it starts planning. The harness controls whether work may start; this
policy controls what work should be proposed.

## Scope

- Add `docs/decisions/0002-portfolio-finish-line.md` recording the durable
  decision: project mode, primary goals, the capability test that governs
  future work, and the explicit statement that roadmap completion is not itself
  a goal.
- Add `docs/portfolio-finish-line.md` as the current program policy: what is
  already sufficiently demonstrated, the bounded feature-complete exit
  criteria, the five remaining slices, and the explicit non-requirements.
- Add a short program-mode rule to `AGENTS.md` that links the finish-line
  document, requires the capability test, and refuses old roadmap entries as
  automatic authorization.
- Make both new documents discoverable from `docs/README.md`.
- Rewrite the untracked local `TODO.md` so its active surface is the bounded
  roadmap only.

## Non-goals

- No application code, schema, or migration.
- No Tool Registry, `ToolExecution`, approval model, MCP dependency, execution
  inspector, Writer Agent, billing, or communication integration. Those are
  what the roadmap *describes*; describing them is not starting them.
- No final README portfolio polish. That is PORT-01's deliverable.
- No rewrite of `AGENTS.md` beyond one added rule, and no weakening of any
  existing invariant or Git/security/deployment policy.
- No conversion of `docs/feature-inventory.md` into a roadmap. It inventories
  implemented capability and stays that way.
- No fix for the pre-existing `organization_audit_event` Prisma index-name
  drift. It is a real maintenance finding and is recorded as one, not repaired
  inside a governance PR.

## Constraints

- The ADR explains *why* and is durable; the finish-line document describes
  *what remains* and is current-state. They must not contradict each other.
- Every capability claimed as already demonstrated must be true of the
  repository at this commit. A governance document that overstates the
  implementation is worse than no document.
- The exit criteria must be checkable. "Demonstrates depth" is not a criterion;
  "durable `ToolExecution` in PostgreSQL" is.
- `AGENTS.md` keeps every existing critical invariant verbatim.

## Acceptance criteria

- [x] ADR 0002 exists, follows the repository ADR convention, and records the
      decision test and the explicit non-goal of roadmap completion.
- [x] `docs/portfolio-finish-line.md` contains the four required sections:
      demonstrated capability, exit criteria, bounded roadmap, non-requirements.
- [x] `AGENTS.md` carries a program-mode rule linking the finish-line document,
      with all prior invariants intact.
- [x] `docs/README.md` links both new documents.
- [x] No implemented capability is described falsely.
- [x] No de-scoped roadmap item is still represented as mandatory anywhere in
      tracked documentation.
- [x] The three program gates P0/P1/P2 are recorded.
- [x] Zero executable or runtime change in the diff.

## Validation

- `pnpm agents:check`
- `ops/tests/documentation.sh`
- `git diff --check`
- Diff inspection confirming no file under `apps/`, `packages/`, `ops/`,
  `.github/`, or any lockfile/schema is touched.

## Required evidence

- The exact commands above with their outcomes.
- The set of changed tracked files.
- Final-head CI green on the PR.

## Decision log

- **The reset is recorded in three places, not one.** An ADR alone would
  explain the decision without constraining behavior; a policy document alone
  would state the constraint without preserving why it was chosen. The
  `AGENTS.md` rule is what an agent actually reads before planning, so the
  binding sentence has to live there and point outward.
- **`TODO.md` is rewritten, not annotated.** Marking a hundred roadmap lines
  `DEFERRED` preserves the same reading burden under a softer label, and a
  future session still has to decide what each one means. Deletion from the
  active surface plus one short future-ideas list is the honest form: those
  items require a new human decision, and a new decision does not need the old
  checkbox to survive.
- **`docs/feature-inventory.md` is left alone.** It is an inventory of what is
  implemented and it is currently accurate. Adding roadmap state to it would
  destroy the one document that answers "what does this system actually do
  today" without qualification.

## Self-review outcomes

Reviewed against the repository at `c903794`, not against memory of it.

1. **Two capability claims were overstated and were corrected before commit.**

   The first said durable idempotency exists "at every consumer" via a caller
   key composed with a body digest. That conflates two different mechanisms.
   Request idempotency at the API boundary is the caller key plus body digest;
   consumer idempotency is a PostgreSQL unique constraint on the business row,
   and the BullMQ dedupe key is neither — it only collapses duplicates while the
   job is still retained in Redis, as `OutboxEvent.dedupeKey` says in the schema.
   Rewritten to name all three layers separately.

   The second said organization isolation is enforced "through composite
   `(id, organizationId)` keys" without qualification, which reads as universal.
   Seven models carry that constraint, and it governs the case that matters —
   one organization-owned row referencing another — but it is not every model.
   Rewritten to state the actual scope.

2. **No de-scoped roadmap item is represented as mandatory in tracked
   documentation.** A sweep for the de-scoped vocabulary returns only: completed
   execution plans recording them as non-goals at the time (historical and
   correct), `carousel` as a `suggestedFormat` enum value in `docs/backend.md`,
   and Stripe as a dependency-injection example in an unrelated NestJS skill.

3. **ADR 0002 and the finish-line document do not contradict each other.** Both
   state five remaining slices, the same capability test, the same treatment of
   defect repair versus manufactured hardening, and the same stop condition.
   Fourteen exit criteria appear once, in the finish-line document; the ADR
   points to them rather than restating them.

4. **`AGENTS.md` is insertions only.** The diff adds fourteen lines and removes
   none, so no invariant and no Git, security, or deployment policy is weakened.

5. **The `organization_audit_event` index-name drift is deliberately not
   fixed here.** It is a real finding, carried forward in the local dashboard.
   Repairing a schema inside a governance PR would break this PR's own claim of
   zero executable change.

## Progress

- [x] Execution plan committed
- [x] ADR 0002
- [x] Finish-line document
- [x] `AGENTS.md` program rule
- [x] `docs/README.md` index
- [x] Local `TODO.md` reset
- [x] Self-review against repository reality
- [x] Validation
- [x] PR opened, final-head CI green

## Blockers

None.

## Verified evidence

- `pnpm agents:check` — "Agent harness validation passed", 113 harness tests
  pass, 0 fail.
- `ops/tests/documentation.sh` — "documentation checks passed".
- `git diff --check` — clean.
- `git diff c903794 --name-only` touches only `AGENTS.md`, `docs/README.md`,
  `docs/decisions/0002-portfolio-finish-line.md`, `docs/portfolio-finish-line.md`,
  and this plan. Nothing under `apps/`, `packages/`, `ops/`, `.github/`, no
  lockfile, no Prisma schema or migration.
- `pnpm agents:resume` parses the rewritten dashboard and reports the slot as
  the single current PR.

## Required corrections

1. **The authorization claim was false and was corrected after review
   (2026-09-01).** The ADR, this plan, and the PR description all asserted that
   a written, unchecked roadmap entry "functions as authorization." It does not.
   `.agents/workflows/pr-train.md` states the approval boundary explicitly: a
   task is approved only as `## [APPROVED] <task id>` with
   `Approved to start: [x]`, and an unchecked box, a bare roadmap entry, or a
   task absent from the window is not approval, with a missing or unreadable
   window blocking every planned slot. I asserted a harness weakness that the
   harness does not have, which overstated the danger and implicitly
   misdescribed HARNESS-01.

   The accurate rationale is that the old roadmap was a stale backlog imposing
   cognitive and resumption burden, causing sessions to repeatedly encounter and
   propose horizontal product work no longer required by the project's purpose.
   The corrected documents state the two layers separately: the harness controls
   whether work may start; the finish-line policy controls what work should be
   proposed and prioritized. The strategic decision is unchanged.

## Outcome

Delivered as PR #58 on `docs/portfolio-finish-line`, based on `main` at
`c90379440e4cca7654d97845c6e3f255c95ce5db`, independent.

The program is now bounded. ADR 0002 records the durable decision and the
capability test, `docs/portfolio-finish-line.md` records what is already proven
and what remains, and `AGENTS.md` binds an agent to the test before it plans.
The old open-ended roadmap is closed rather than deferred: reopening any
de-scoped capability requires a new explicit human decision.

Gate P0 closes when this merges. TOOL-01 is next and needs its own approval.
