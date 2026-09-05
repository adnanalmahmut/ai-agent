# ADR 0002: Target service decomposition for the restructuring

- Status: Accepted (target architecture, not implemented)
- Date: 2026-09-06

## Context

The repository is one pnpm monorepo whose backend runs as three composition
roots out of a single NestJS source tree (`apps/backend/src/api/main.ts`,
`apps/backend/src/workers/main.ts`, `apps/backend/src/cli/main.ts`). Product
data, agent execution, and tool side effects share one Prisma client and one
database. A restructuring will separate those responsibilities, and the
separation only stays coherent if the destination is agreed before any file
moves.

[ADR 0001](0001-environment-state-model.md) already forbids describing prepared
tooling as live. The same rule applies here: nothing below exists yet.

## Decision

The decisions are recorded as the agreed destination. None of them describes
the current repository, and none of them authorises building or running the
new topology.

### Applications

- `apps/web` stays the public site. Customer-facing product screens live in an
  `app` surface and platform administration in an `admin` surface, rather than
  both sharing one authenticated tree.
- The Control Plane owns product data, permissions, approvals, and
  orchestration. It is the only component that decides what may happen.

### Runtime and tools

- The AI Runtime and the Tool Executor are two replaceable units behind
  serialized contracts, so either can be substituted without touching the
  Control Plane.
- Neither the Runtime nor the Executor reaches product tables through Prisma.
  Product state is read and written only through Control Plane contracts.
- TypeScript remains the implementation language. No component is rewritten in
  another language as part of the restructuring.

### Orchestration and delivery

- Temporal becomes the orchestration engine, including transactional mail.
- BullMQ is transitional only. Redis keeps its other uses — rate limiting,
  caching, and coordination — after the queues move.
- The transactional outbox, durable idempotency, and the external-effect
  guarantees are preserved through the migration. They are not deleted, and
  they are not weakened to make a move easier.
- Security mail (verification, password reset, invitation) belongs to the
  Control Plane and runs on a dedicated worker and queue rather than sharing a
  general-purpose one.

### Storage and operations

- R2 stores file content. PostgreSQL keeps the metadata and the authorization
  facts about those files, so access decisions never depend on the object
  store.
- Observability is an OTel Collector in front of Prometheus, Tempo, Loki, and
  Grafana.
- An `infra` area owns operational composition, and Nginx remains the single
  ingress.

## Consequences

- Later phases must justify any move against this list, and a move that
  requires the Runtime or the Executor to reach product tables directly is out
  of contract, not a shortcut.
- Removing BullMQ is a migration step with an owner, not an implied side effect
  of adopting Temporal.
- Because these are target decisions, documentation must not claim any of them
  as current behavior. The current baseline is recorded in
  [the migration baseline](../exec-plans/restructuring-baseline.md).

## Rejected alternatives

- Moving files first and settling the boundaries afterwards. The current tree
  has three composition roots over one schema; without an agreed destination
  the first extraction decides the architecture by accident.
- Keeping BullMQ alongside Temporal permanently. Two orchestrators means two
  retry, two fencing, and two idempotency stories over the same effects.
