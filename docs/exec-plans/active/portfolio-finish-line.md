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

A written roadmap is authorization in practice: the next session reads it and
treats an unchecked box as work owed. So the reset has to be recorded where the
authority actually lives — an ADR for the durable decision, a current-state
document for what remains, and a short rule in `AGENTS.md` so a future agent
meets the constraint before it starts planning.

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

- [ ] ADR 0002 exists, follows the repository ADR convention, and records the
      decision test and the explicit non-goal of roadmap completion.
- [ ] `docs/portfolio-finish-line.md` contains the four required sections:
      demonstrated capability, exit criteria, bounded roadmap, non-requirements.
- [ ] `AGENTS.md` carries a program-mode rule linking the finish-line document,
      with all prior invariants intact.
- [ ] `docs/README.md` links both new documents.
- [ ] No implemented capability is described falsely.
- [ ] No de-scoped roadmap item is still represented as mandatory anywhere in
      tracked documentation.
- [ ] The three program gates P0/P1/P2 are recorded.
- [ ] Zero executable or runtime change in the diff.

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

## Progress

- [x] Execution plan committed
- [ ] ADR 0002
- [ ] Finish-line document
- [ ] `AGENTS.md` program rule
- [ ] `docs/README.md` index
- [ ] Local `TODO.md` reset
- [ ] Self-review against repository reality
- [ ] Validation
- [ ] PR opened, final-head CI green

## Blockers

None.
