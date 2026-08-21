# Incident-debugging workflow

## Entry contract

Start with observed impact, time window, affected environment, available sanitized signals, and explicit operational authority.

## State graph

`ASSESS -> CONTAIN_DECISION -> GATHER -> HYPOTHESIZE -> TEST -> DIAGNOSE -> HANDOFF -> DONE`

`TEST -> HYPOTHESIZE` is bounded to three hypothesis cycles. Any live mutation, credential need, destructive action, or widening impact transitions to `ESCALATE` unless explicitly authorized.

## States

1. **ASSESS** — Establish severity, user/data impact, timeline, and whether secrets may be involved. Preserve evidence.
2. **CONTAIN_DECISION** — Recommend containment if needed, but do not perform external or live changes without explicit authority.
3. **GATHER** — Collect the minimum sanitized logs, metrics, revisions, configuration facts, and reproduction data.
4. **HYPOTHESIZE** — Rank falsifiable causes by evidence and blast radius.
5. **TEST** — Test one hypothesis with read-only or safe local diagnostics. Increment the counter; return to HYPOTHESIZE when disproved, escalating after three cycles.
6. **DIAGNOSE** — State root cause and confidence, affected surface, and why alternatives were rejected.
7. **HANDOFF** — Provide a scoped remediation, rollback or recovery considerations, validation plan, and follow-up prevention work. Operational execution remains separately authorized.
8. **DONE** — Record a sanitized evidence summary and unresolved uncertainty.
9. **ESCALATE** — Stop immediately for secret exposure, destructive or production action, missing incident authority, or exhausted safe diagnosis.

## Small-task shortcut

There is no shortcut around ASSESS or the live-action boundary. For a local-development incident, CONTAIN_DECISION and GATHER may be combined.
