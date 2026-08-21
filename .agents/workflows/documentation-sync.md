# Documentation-synchronization workflow

## Entry contract

Start with the changed behavior or stale claim, authoritative source, affected audiences, and documentation scope.

## State graph

`INVENTORY -> VERIFY_SOURCE -> UPDATE -> CHECK -> REVIEW -> DONE`

Failures transition `CHECK -> REPAIR -> CHECK`; repair is bounded to three cycles before `ESCALATE`.

## States

1. **INVENTORY** — Locate every relevant claim across guides, runbooks, examples, decisions, agent context, and configuration references.
2. **VERIFY_SOURCE** — Establish current truth from code, tests, deployed-state documentation, or current primary vendor documentation.
3. **UPDATE** — Change the smallest complete set of docs, keeping examples safe and removing stale contradictions.
4. **CHECK** — Validate local links, commands, terminology, deployment-state consistency, and repository documentation checks.
5. **REPAIR** — Fix one evidenced consistency failure, increment the counter, and return to CHECK; escalate after three cycles.
6. **REVIEW** — Read as the target audience and confirm that assumptions, limits, and ownership are explicit.
7. **DONE** — Report updated claims, authoritative basis, checks run, and any intentionally deferred docs.
8. **ESCALATE** — Stop when authoritative sources conflict, current environment state cannot be verified, or repair cycles are exhausted.

## Small-task shortcut

For a single factual correction, combine INVENTORY and VERIFY_SOURCE, but still search for duplicate claims and run CHECK.
