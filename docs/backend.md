# Backend

`apps/backend` is a NestJS 11 service with three entrypoints:

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

`apps/backend/eslint.config.mjs` owns syntactic auth/mail boundaries through
standard ESLint import, property, and syntax restrictions. It prevents private
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

The worker leases routable outbox rows, publishes `{ runId }` to BullMQ, and
marks the event delivered only after publish succeeds. The consumer reloads all
execution authority from PostgreSQL, conditionally claims the run, executes the
pinned definition, validates the result, and conditionally writes the terminal
state. See [Redis, queue, and outbox](redis-queue-outbox.md).

Agent tools pass through one gateway. Exact versioned grants are narrowed by the
organization installation. Read-only tools execute inline. Side-effect tools
only create an approval record; after an authorized decision, the worker
revalidates and performs the effect idempotently. MCP sessions expose the same
gateway and cannot bypass the approval lifecycle.

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

Use `pnpm --filter backend test`, `test:e2e`, `lint`, `typecheck`, and
`build` for backend validation. The app-local command list is in
[apps/backend/README.md](../apps/backend/README.md).
