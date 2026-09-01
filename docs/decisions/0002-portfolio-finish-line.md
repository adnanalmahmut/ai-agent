# ADR 0002: Bound the program to a portfolio finish line

- Status: Accepted
- Date: 2026-09-01

## Context

This repository was built against an open-ended product roadmap: a
multi-channel content SaaS with a writer pipeline, brand system, storage and
document ingestion, web research, image generation, social publishing,
messaging channels, billing, analytics, and a generalized workflow engine.

What the repository actually became is a deep engineering demonstration. It now
carries multi-tenant isolation enforced in the schema, two separate RBAC
domains, an append-only product audit trail, a durable agent runtime behind a
replaceable adapter, definition and version pinning, a transactional outbox with
at-least-once delivery and durable idempotency, retry/fencing/reconciliation,
encrypted managed secrets with a versioned keyring and resumable rotation, and a
full CI/CD, migration, container, and backup-restore chain.

The remaining roadmap items do not extend that depth. They extend product
breadth. Adding a social publishing calendar or a billing ledger to a system
that already demonstrates transactional outbox delivery proves nothing new about
the engineering; it adds surface area, maintenance cost, and review burden to a
project whose purpose is to be read.

The roadmap is also a live hazard. A written, unchecked roadmap entry functions
as authorization: a session resuming work reads it as outstanding obligation and
implements it. Left in place, the old roadmap would keep directing effort at
breadth indefinitely, and "finished" would never arrive because nothing defined
what finished meant.

## Decision

The project's mode is **Portfolio / Engineering Demonstration**.

Its primary goals are:

1. Demonstrate backend production engineering depth.
2. Demonstrate AI agent engineering depth.
3. Produce strong, inspectable evidence suitable for interviews and portfolio
   review.
4. Stop once the remaining meaningful architectural capabilities are proven.
5. Avoid horizontal product breadth and speculative abstraction.

Every proposed engineering item must pass one test:

> **Does this work prove a meaningful engineering capability that this
> repository does not already demonstrate?**

If the answer is no, the work is not prioritized — and specifically, it is not
prioritized merely because it appeared on an older roadmap. Appearing on a
previous roadmap is not authorization and never becomes authorization by age.

**Roadmap completion is not a goal in itself.** The program does not finish by
emptying a backlog; it finishes by satisfying the bounded exit criteria in
[the portfolio finish line](../portfolio-finish-line.md). Items outside those
criteria are not deferred obligations. They are closed unless a new explicit
human decision reopens them with independent engineering justification.

Real defects remain fixable at any time. Fixing a genuine bug does not require
passing the capability test. Manufacturing hardening work to inflate coverage
does not pass it.

## Consequences

- [`docs/portfolio-finish-line.md`](../portfolio-finish-line.md) is the current
  program policy: what is already sufficiently demonstrated, the exit criteria,
  the bounded remaining roadmap, and the explicit non-requirements. This ADR
  explains why; that document states what remains.
- [`AGENTS.md`](../../AGENTS.md) carries the binding rule, so an agent meets the
  constraint before it begins planning rather than after it has built something.
- The remaining program is five slices — TOOL-01, ACT-01, MCP-01, DEMO-01,
  PORT-01 — after which the project is **feature complete** and feature
  development stops.
- Declaring feature completeness is a stopping condition, not a maintenance
  freeze. Defect repair, dependency currency, and documentation accuracy
  continue.
- Reopening any de-scoped capability requires a new human decision. Superseding
  this ADR is the mechanism if the project's purpose itself changes.
- This decision constrains prioritization only. It does not relax any
  engineering, security, delivery, or deployment boundary recorded in
  `AGENTS.md`, [`.agents/policies/`](../../.agents/policies/), or
  [ADR 0001](0001-environment-state-model.md).
