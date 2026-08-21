# Execution plans

Use an execution plan for substantial, multi-phase work whose state must
survive handoffs. Small changes should use the normal task brief and checklist.

An active plan records goal, context, scope/non-goals, constraints, acceptance
criteria, validation, required evidence, decision log, progress, and blockers.
Store it under `active/`. When the work lands, summarize outcomes and move the
plan to `completed/` in the same change; do not retain a false active state.

Plans coordinate work but do not override `AGENTS.md`, security boundaries, or
the repository's source of truth. Do not put credentials or live operational
data in a plan.
