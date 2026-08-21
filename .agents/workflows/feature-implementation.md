# Feature implementation workflow

## Entry contract

Start with a requested outcome, acceptance criteria, affected surface, and explicit delivery boundary.

## State graph

`INTAKE -> DISCOVER -> DESIGN -> IMPLEMENT -> VERIFY -> REVIEW -> DONE`

Failure transitions: `VERIFY -> REPAIR -> VERIFY` and `REVIEW -> REPAIR -> VERIFY`, each sharing a maximum of three repair cycles. Any unsafe or unresolved decision transitions to `ESCALATE`.

## States

1. **INTAKE** — Restate outcome, constraints, non-goals, and authority. Exit when acceptance criteria are testable.
2. **DISCOVER** — Read guidance, architecture, relevant source, and existing tests. Use the explorer role only if discovery is substantial. Exit with an evidence-backed change map.
3. **DESIGN** — Choose the smallest coherent approach, note risks and migrations, and identify validation. Exit when no material product or architecture choice is being guessed.
4. **IMPLEMENT** — Use the implementer contract; preserve unrelated work and keep the diff scoped. Exit when the intended behavior and focused tests exist.
5. **VERIFY** — Run focused tests, then required repository checks. Exit on clean results or transition to REPAIR with exact failure evidence.
6. **REPAIR** — Diagnose one evidenced failure, make the smallest correction, increment the shared repair counter, and return to VERIFY. After attempt three, transition to ESCALATE.
7. **REVIEW** — Apply code-review and, where relevant, security-review contracts to the complete diff. Findings return to REPAIR.
8. **DONE** — Report outcome, changed files, commands and results, risks, and unperformed actions.
9. **ESCALATE** — Stop with the decision, access, safety, or repeated-failure blocker and the evidence gathered.

## Small-task shortcut

For a localized, low-risk edit with an obvious implementation, combine DISCOVER and DESIGN and work without delegation. Continue through VERIFY and REVIEW.
