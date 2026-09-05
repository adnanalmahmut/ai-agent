# Agent workflows

These workflows are canonical, tool-neutral execution graphs. Every transition requires evidence, and every repair loop is bounded to three attempts before escalation.

- [Feature implementation](feature-implementation.md)
- [Bug fixing](bug-fixing.md)
- [Pull-request review](pr-review.md)
- [Incident debugging](incident-debugging.md)
- [Documentation synchronization](documentation-sync.md)

## Shared rules

1. The parent agent owns state transitions and the final decision.
2. A small task may skip delegation, but never skips scope, validation, or safety checks.
3. Parallel work is allowed only for independent, bounded subtasks with non-overlapping writes.
4. After three unsuccessful repair or hypothesis cycles, stop and escalate with evidence.
5. Publishing, deployment, merge, and destructive actions require the authority stated in `AGENTS.md` and the safety policy.
6. Conversation memory is never authoritative state. Git, GitHub PR state, and final-head CI are. For multi-PR sessions see the [Git and delivery policy](../policies/git-and-delivery.md).
