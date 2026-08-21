# Bug-fixing workflow

## Entry contract

Start with an observable symptom, expected behavior, environment, scope, and available evidence.

## State graph

`TRIAGE -> REPRODUCE -> ISOLATE -> TEST -> FIX -> VERIFY -> REVIEW -> DONE`

Failure transitions: `REPRODUCE -> HYPOTHESIS`, `VERIFY -> REPAIR -> VERIFY`, and `REVIEW -> REPAIR -> VERIFY`. Hypothesis and repair work share a maximum of three cycles before `ESCALATE`.

## States

1. **TRIAGE** — Assess severity, affected users, data risk, and whether this is an incident. Exit when the safe diagnostic boundary is known.
2. **REPRODUCE** — Create the smallest safe local reproducer and capture expected versus actual behavior.
3. **HYPOTHESIS** — When reproduction is unclear, test one falsifiable cause at a time. Increment the cycle count; return to REPRODUCE or escalate after three cycles.
4. **ISOLATE** — Trace the reproducer to a root cause and rule out adjacent plausible causes.
5. **TEST** — Add a regression test that demonstrates the defect when practical.
6. **FIX** — Make the smallest root-cause correction; avoid unrelated cleanup.
7. **VERIFY** — Run the regression test, adjacent suite, and required repository checks. Evidenced failures enter REPAIR.
8. **REPAIR** — Correct the validated failure, increment the cycle count, and return to VERIFY; escalate after three cycles.
9. **REVIEW** — Review the full diff for regression, error handling, and security impact. Findings return to REPAIR.
10. **DONE** — Report cause, fix, proof, residual uncertainty, and commands run.
11. **ESCALATE** — Stop for live-only reproduction, destructive diagnostics, sensitive data, ambiguous expected behavior, or exhausted cycles.

## Small-task shortcut

For an already-reproduced localized defect, combine REPRODUCE and ISOLATE. A regression test and verification remain required where practical.
