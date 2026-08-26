# Bounded PR train

The canonical contract for one engineering session that produces several
independently reviewable pull requests. Everything else that mentions trains
routes here.

The problem it solves: a long session is interrupted by automatic compaction,
restart, or a stop. After that, conversation memory is gone. The train state has
to live somewhere a fresh agent can read, and it has to be impossible to read it
optimistically.

## Core principle

**Conversation memory is never authoritative.** A compaction is a process
restart, not continuity of memory.

Authority order:

1. Git and the commit graph
2. Canonical repository policy and the tracked execution plan
3. GitHub PR state and final-head CI
4. The local `TODO.md` dashboard
5. Source and runtime evidence for anything still unresolved

`TODO.md` is a local operational dashboard. It is never allowed to overrule Git
or GitHub, and it is not a substitute for a tracked exec plan.

## Size

| | Value |
|---|---|
| Default configured maximum open implementation PRs | 3 |
| Hard maximum the workflow supports | 4 |

A fourth PR is **not** started automatically when the configured limit is 3.
When the occupied slots reach the configured limit, `pnpm agents:resume` prints
`TRAIN LIMIT REACHED — HUMAN CHECKPOINT REQUIRED` and does not name another
roadmap PR as the next action. A dashboard configuring more than 4 fails to
parse: that is a malformed dashboard, not a bigger train.

A slot occupies the train unless it is `PLANNED` (not started) or `MERGED`
(gone).

## States

```
PLANNED -> ACTIVE -> IMPLEMENTED -> LOCAL_VERIFIED -> PR_OPEN
        -> CI_PENDING -> CI_GREEN -> REVIEW_FINDINGS -> READY_FOR_HUMAN -> MERGED
```

`BLOCKED` is an off-ramp reachable from any state and is not part of the order.

States carry obligations, and a claim without its evidence fails to parse:

| State | Requires |
|---|---|
| anything past `PLANNED` | `Branch` |
| `PR_OPEN` and later | `PR number` |
| `CI_GREEN`, `REVIEW_FINDINGS`, `READY_FOR_HUMAN`, `MERGED` | `Head SHA` |

That is what makes "resume must not guess silently" enforceable: a slot cannot
assert it was verified without naming the commit that was verified.

## Dependencies

Three shapes, and only three:

| Shape | `Base` | `Depends on` | `Dependency type` |
|---|---|---|---|
| independent | `main` | `none` | `independent` |
| true stack | the dependency's branch | that slot | `stacked` |
| sibling | the shared ancestor's branch | the shared ancestor | `stacked` |

Siblings are **derived**, never declared: two slots are siblings when they
depend on exactly the same thing and not on each other.

```
             +-- AUD-01   (base feat/organization-business-settings, depends on PR 1)
ORG-01 ------+
             +-- AGT-01   (base feat/organization-business-settings, depends on PR 1)
```

`AGT-01` must **not** record a dependency on `AUD-01` merely because `AUD-01`
was written first.

**Rule: stack only when a real code/data/API dependency exists.** Sequential
agent execution is not a dependency. A stacked slot should record a
`Dependency reason` naming the actual coupling; a stack without one warns.

The base and the declared dependency must agree, in both directions. A slot
based on another slot's branch without declaring the dependency fails to parse,
and so does a slot declaring a dependency whose branch is not its base. That
agreement is the only physical evidence a dependency exists, and it is what
stops siblings from silently becoming a deep stack.

## Proceeding to the next PR in one session

Allowed without human interaction only when all of these hold:

- the previous PR reached its handoff requirement,
- the dependency structure is known and recorded,
- the train limit permits another slot,
- the next roadmap task is explicitly `Approved to start`,
- no blocking review finding invalidates the shared foundation.

Default handoff before starting another PR: implementation complete, required
local validation green, self-review complete, legitimate findings repaired, PR
opened, final-head CI green.

**The one relaxation, deliberately narrow.** You may begin work on an
independent or sibling PR while an earlier PR's CI is still running, provided:

- the earlier slot stays `CI_PENDING` — it is never advanced to `CI_GREEN`
  without actual CI evidence;
- the new work does not depend on the pending PR. A *dependent* slot is blocked
  until its dependency reaches `CI_GREEN`, because dependent work would
  otherwise build on an unverified change;
- a CI failure becomes an entry under `# UNRESOLVED FINDINGS`, which blocks the
  train's human handoff;
- the train stays within its configured size.

Why this rule and not a more permissive one: a sibling shares its ancestor's
*commit*, not the pending change, so a CI failure in the pending PR cannot
invalidate the sibling's foundation. A dependent PR shares the change itself, so
it can. The resume output enforces the distinction by refusing to name dependent
work as the next action while its dependency is unverified.

## Merge, rebase, and retarget

The agent never merges and never enables auto-merge. Human merge is
authoritative.

When a dependency PR merges, dependent slots need their base reconciled to
`main`. Resume reports this as a `retarget` finding. It is a **human-safe**
reconciliation: ask for a retarget or a forward merge. Do not force-push, do not
rewrite history, and do not invent history-rewriting automation.

## Checkpointing

Update the dashboard after every objectively important transition:

- branch created
- a coherent implementation checkpoint committed
- PR opened
- PR base changed
- PR dependency changed
- CI completes
- review finding discovered
- review finding repaired
- final head changes
- current PR changes
- before an intentional compaction
- before stopping the session

Do not commit incomplete or broken code merely to checkpoint state. The working
tree is recoverable evidence and resume inspects it; a commit is not the only way
to persist a fact.

## Dashboard schema

```
# ACTIVE PR TRAIN

Train: <identifier>
Train state: <free text>
Anchor main SHA: <sha>
Configured max open PRs: <1..4>
Current PR: <slot>
Merge order if constrained: <free text or none>

## PR <slot> — <roadmap/task id>

Task: <what it delivers>
Branch: <branch>
Base: main | <dependency branch>
Base SHA: <sha or none>
PR number: <number or none>
PR URL: <url or none>
Head SHA: <sha or none>
State: <state literal>
Depends on: none | PR <slot>[, PR <slot>]
Dependency type: independent | stacked
Dependency reason: <the real coupling; required in spirit for a stack>
Merge order constraint: <free text or none>
Last verified: <date>
Next exact action: <one concrete action>

Checklist:
- [ ] discovery
- [ ] design
- [ ] implementation
- [ ] narrow verification
- [ ] aggregate verification
- [ ] self-review
- [ ] specialist review where required
- [ ] repair
- [ ] final-head CI
- [ ] human handoff

# TRAIN DECISIONS

Only durable decisions later PRs in this train need.

# UNRESOLVED FINDINGS

- [ ] findings that must survive compaction

# CURRENT CHECKPOINT

- Current train / Current PR / Current branch / Current HEAD
- PR/base relationship
- Last objectively verified state
- Exact next legitimate action

# APPROVED EXECUTION WINDOW

Roadmap authorization boundaries, unchanged.
```

`none`, `n/a`, `-`, and `tbd` all read as deliberately empty.

## Resume

`pnpm agents:resume` is the takeover mechanism. It is read-only: it runs
inspection commands and prints. It reports the repository root, dashboard path
and ignore status, train identifier, configured limit, occupied slots, anchor
main SHA, current PR and branch, HEAD, git status, recent graph, staged and
unstaged state, each recorded PR's live number/head/base/mergeability/checks and
dependency relationship, derived sibling groups, the next legitimate action,
unresolved findings, and train-limit status.

It then reconciles evidence against the dashboard and reports drift rather than
repairing it silently. Detected classes: main advanced past the anchor, worktree
on a different branch than the current slot records, a PR merged or closed behind
the dashboard, head or base mismatch, a `CI_GREEN` claim contradicted by actual
checks, a merged dependency needing retarget, inherited uncommitted work, and any
recorded PR whose GitHub state could not be read.

A dashboard that does not parse stops resume with exit code 2 and an explicit
error list. The single-PR predecessor is recognized by name and answered with
migration instructions rather than a generic failure.

## State graph

```
RESUME -> RECONCILE -> READ_PLAN -> INSPECT_INHERITED -> CONTINUE_CURRENT
RECONCILE -> DRIFT -> RESOLVE_DELIBERATELY -> RECONCILE   (max 3 cycles)
CONTINUE_CURRENT -> HANDOFF -> NEXT_SLOT | TRAIN_LIMIT_REACHED
DRIFT (unresolved after 3 cycles) -> ESCALATE
TRAIN_LIMIT_REACHED -> ESCALATE
parse failure -> ESCALATE
```

Bounded loop: attempt reconciliation of a given drift at most three times.
`ESCALATE` means stop and report to the human with the exact command, output, and
the decision required. Do not proceed past `TRAIN_LIMIT_REACHED` on your own
judgment.

## Forbidden

- merging, or enabling auto-merge
- `reset`, `stash`, `clean`, discarding, or overwriting inherited work
- force-pushing or rewriting history
- automatic rebasing, retargeting, or conflict resolution
- starting a PR outside the approved execution window
- starting slot N+1 when the train limit is reached
- treating conversation memory as authoritative
- rewriting a source-of-truth fact to make the dashboard consistent

## Non-goals

Not a DAG engine, project-management system, GitHub bot, merge queue, lock
manager, parallel-agent orchestrator, or persistent database. It is a small
repository-local harness for a solo developer: one pure parser/state module, one
read-only resume script, and this contract.

## Limitations, stated rather than glossed

- **An unnecessary but physically real stack is undetectable.** The model catches
  a *declared* dependency that the base contradicts. It cannot know whether a
  branch genuinely based on another branch had to be: if the agent branches PR-C
  off PR-B and declares the dependency, base and declaration agree and the model
  accepts a true stack. `Dependency reason` is the only mitigation — the reason
  has to name the coupling, and "written after PR-B" is not one. Prefer branching
  from the shared ancestor by default; that choice is a judgment the file cannot
  make for you.
- **Checkpoint quality is not enforceable.** Resume warns when a slot records no
  `Next exact action`, but a checkpoint written carelessly still parses. What
  survives a compaction is what was written down.
- **GitHub evidence can be unavailable.** When `gh` is missing or
  unauthenticated, resume says so explicitly and reports that PR-level drift was
  *not* checked. Absence of drift findings in that case is not evidence of
  agreement.
- **Rename entries in the dirty-path report are shown as `old -> new`.** Adequate
  for "inspect this before editing", not a parseable path list.

## Implementation

- `.agents/scripts/pr-train.mjs` — pure parser, state machine, limit, dependency
  and sibling derivation, and reconciliation. No I/O.
- `.agents/scripts/resume-task.mjs` — integration boundary that gathers Git and
  GitHub evidence and prints the snapshot.
- `.agents/scripts/__tests__/pr-train.test.mjs` — parser/state tests plus
  mutation probes on the train-limit guard and the base/dependency agreement
  check. Run by `pnpm agents:check`.
