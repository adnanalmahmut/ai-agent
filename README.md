# AI Agent

This pnpm monorepo runs a public website, an authenticated operations platform,
and a multi-tenant agent service. The service stores organization knowledge,
runs versioned agents, records content ideas and projects, and gates external
side effects behind human approval.

| Workspace            | Purpose                                            | Runtime                   |
| -------------------- | -------------------------------------------------- | ------------------------- |
| `apps/web`           | Public site                                        | Next.js 16                |
| `apps/platform`      | Authenticated organization and platform operations | Next.js 16                |
| `apps/backend`       | HTTP API, background worker, and operator CLI      | NestJS 11                 |
| `packages/ui`        | Shared React components and styles                 | React 19 / Tailwind CSS 4 |
| `packages/i18n-core` | Shared locale contracts                            | TypeScript                |

PostgreSQL is the durable store. Redis provides BullMQ transport and rate-limit
coordination. Better Auth handles authentication and organization membership;
Prisma owns application persistence; Mastra is isolated behind the internal
agent runtime contract.

## Local development

Requirements: Node.js 24, pnpm 10.29.3, Docker Compose, and the required values
from `apps/backend/.env.example`.

```sh
pnpm install
pnpm db:up
pnpm db:deploy
pnpm dev:backend       # API on 3002
pnpm dev:worker        # run in a second terminal
pnpm dev:web           # public site on 3000
pnpm dev:platform      # operations platform on 3001
```

Use `pnpm db:migrate` when developing a new Prisma migration. `pnpm db:deploy`
only applies committed migrations.

## Validation

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend test:e2e
pnpm build
infra/tests/documentation.sh
```

Backend E2E tests use isolated PostgreSQL and Redis services from the Compose
`test` profile.

## Deployment

Merges to `main` run CI, publish one immutable image set, and deploy that exact
set to Staging. Staging is the only provisioned environment. Production
workflows and host tooling exist but Production is not provisioned or operated.
Read [deployment state](docs/deployment-state.md) before delivery or operations
work.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Backend](docs/backend.md), [frontends](docs/frontend.md), and
  [implemented features](docs/feature-inventory.md)
- [Authentication and RBAC](docs/authentication-rbac.md)
- [Database](docs/database.md) and [queue/outbox](docs/redis-queue-outbox.md)
- [Configuration](docs/configuration.md) and [security](docs/security.md)
- [CI](docs/ci.md), [CD](docs/cd.md), and [operations](docs/operations-runbook.md)
