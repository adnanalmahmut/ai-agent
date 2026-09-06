# Backend

`apps/control-plane` is a NestJS 11 service with three entrypoints:

| Entrypoint            | Responsibility                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| `src/api/main.ts`     | HTTP, authentication, validation, authorization, and transactional acceptance |
| `src/workers/main.ts` | Outbox dispatch, BullMQ consumers, reconciliation, and approved side effects  |
| `src/cli/main.ts`     | Bounded operator commands; runs once and exits                                |

The API and worker use the same runtime image but different composition roots.
The migration image only contains what Prisma migration deployment needs.

## Source ownership

```text
src/
├── core/             application-independent primitives
├── ai/               agent definitions, model catalog, runtimes, and tools
├── features/         organization and product capabilities
├── modules/          transport-neutral application use cases
├── infrastructure/   auth, config, database, HTTP, mail, Redis, queue, outbox
├── api/              HTTP composition root
├── workers/          worker composition root and handlers
└── cli/              operator composition roots and commands
```

Features currently cover organization settings and audit, organization-agent
installation/versioning, knowledge ingestion and retrieval, content ideas and
projects, tool approvals, MCP sessions, and the platform control plane. The
code-owned registry is the authority for agent, model, and tool identities.

## Architectural checks

`apps/control-plane/eslint.config.mjs` owns syntactic auth/mail boundaries and the
run use-case import boundary through standard ESLint import, property, and
syntax restrictions. It prevents private
mail/provider imports, role-based authorization shortcuts, unpaired
`RequireActiveOrg` decorators, hard-delete calls/routes, session cache/storage
configuration, and Nest controllers on Better Auth routes. The CLI bootstrap
and super-admin guard-table exceptions remain narrowly scoped.

`test/unit/eslint-boundaries.spec.ts` exercises the actual configuration with
allowed and prohibited TypeScript fixtures. Behavioral authorization, tenant
isolation, mail delivery, and Nest composition stay in their existing Jest
suites; the mail boundary suite checks the public export and injection contract
at runtime.

## Request and execution flows

A background agent request is accepted in one PostgreSQL transaction:

1. Validate the caller, organization permission, feature availability, and
   idempotency key.
2. Resolve and pin the agent definition, installed organization version, model
   policy, model, and pricing revision.
3. Insert the `AgentRun` and matching outbox event.
4. Commit before attempting any Redis operation.

That transaction is `modules/runs/accept-agent-run.use-case.ts`. Nothing about
how the work will be delivered takes part in it.

The worker leases routable outbox rows, publishes `{ runId }` to BullMQ, and
marks the event delivered only after publish succeeds. The consumer reloads all
execution authority from PostgreSQL, conditionally claims the run, executes the
pinned definition, validates the result, and conditionally writes the terminal
state. That is `modules/runs/execute-agent-run.use-case.ts`; the BullMQ handler
turns a delivery into a run id, an attempt ordinal and a last-delivery flag,
and turns the returned outcome back into an acknowledgement or a rejection.
See [Redis, queue, and outbox](redis-queue-outbox.md).

Agent tools pass through one gateway. Exact versioned grants are narrowed by the
organization installation. Read-only tools execute inline. Side-effect tools
only create an approval record; after an authorized decision,
`modules/approvals/deliver-approved-tool-effect.use-case.ts` revalidates against
durable state and performs the effect idempotently. Authorization returns the
authorized Control Plane preparer and the pinned definition, never a provider.
The preparer resolves the effective payload, computes its digest, and builds a
function-free, data-only `SideEffectDeliveryCommand`; `SideEffectDeliveryPort`
receives that authorized command and a stable idempotency key. A provider
adapter therefore holds no Prisma access, no approval record, no organization
state and no agent definition. MCP sessions expose the same gateway and cannot
bypass the approval lifecycle.

Knowledge is organization-scoped. Ingestion stores documents and chunks, then
uses the outbox for embedding work. Retrieval applies the agent definition's
space and budget policy before material reaches a model.

## HTTP conventions

- Zod-backed configuration and request validation fail at the boundary.
- Successful application responses use the shared response envelope except for
  explicitly raw routes.
- Errors expose stable codes and safe details; logs carry request IDs and
  contained diagnostics.
- `GET /api/health/live` checks the process only.
- `GET /api/health/ready` checks drain state and required dependencies.
- OpenAPI is optional and disabled unless configured. The document builder
  in `src/infrastructure/docs` is also what platform API type generation
  reads, so a payload contract change is a platform-visible change; see
  [frontend](frontend.md).

## Operator commands

`super-admin:create` creates the first super administrator and refuses once
any such account exists. `managed-secret:rotate-key` re-encrypts stored
credentials under the active key version. They use separate composition roots
because their database authority must not be combined. Use the exact procedures
in [the operations runbook](operations-runbook.md).

## Development

From the repository root:

```sh
pnpm db:up
pnpm db:deploy
pnpm dev:backend
pnpm dev:worker
```

Use `pnpm --filter control-plane test`, `test:e2e`, `lint`, `typecheck`, and
`build` for backend validation. The app-local command list is in
[apps/control-plane/README.md](../apps/control-plane/README.md).
