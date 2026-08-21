# Pull-request review workflow

## Entry contract

Start with the base and head revisions, intended outcome, acceptance criteria, and available CI evidence.

## State graph

`SCOPE -> MAP -> REVIEW -> VALIDATE -> REPORT -> DONE`

Unclear behavior transitions `REVIEW -> INVESTIGATE -> REVIEW`; investigation is bounded to three cycles. Missing essential context or unsafe validation transitions to `ESCALATE`.

## States

1. **SCOPE** — Confirm the exact diff, dependency stack, non-goals, and whether review actions are authorized.
2. **MAP** — Identify changed boundaries, callers, data flows, tests, operations, and documentation.
3. **REVIEW** — Inspect for concrete correctness, regression, maintainability, test, and operational risks. Invoke security review for changed trust boundaries.
4. **INVESTIGATE** — Reproduce or trace one uncertain high-impact issue; increment the cycle counter and return to REVIEW. After three cycles, report the uncertainty rather than speculate.
5. **VALIDATE** — Run safe, relevant checks or inspect trustworthy CI evidence. Never claim an unrun check.
6. **REPORT** — Lead with actionable findings ordered by severity and include path, line, failure scenario, evidence, and remedy. Then list residual gaps.
7. **DONE** — Return the review to the parent or requester; do not merge or publish actions unless explicitly authorized.
8. **ESCALATE** — Stop when the diff cannot be resolved, necessary data is sensitive, or validation would affect live systems.

## Small-task shortcut

For a tiny documentation-only diff, combine MAP and REVIEW, then validate links and consistency before reporting.
