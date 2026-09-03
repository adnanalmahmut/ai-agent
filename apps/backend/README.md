# Backend

NestJS API, background worker, and operator CLI for the agent service.

## Commands

From this workspace:

```sh
pnpm db:up
pnpm db:deploy
pnpm dev              # API
pnpm worker:dev       # worker, in another terminal
pnpm cli:dev -- --help
pnpm test
pnpm test:e2e
pnpm lint
pnpm typecheck
pnpm build
```

From the repository root, use `pnpm dev:backend`, `pnpm dev:worker`, and the
root validation commands.

## Entrypoints

| Process | Entrypoint            | Owns                                                                      |
| ------- | --------------------- | ------------------------------------------------------------------------- |
| API     | `src/api/main.ts`     | HTTP, authentication, authorization, and transactional writes             |
| Worker  | `src/workers/main.ts` | Outbox dispatch, BullMQ consumption, reconciliation, and approved effects |
| CLI     | `src/cli/main.ts`     | Host-authorized one-shot commands                                         |

The API has no BullMQ consumer. The worker has no HTTP listener. Migrations run
from the separate migration image rather than during application startup.

Configuration is validated at boot from
`src/infrastructure/config/*.config.ts`; `.env.example` lists local names and
safe defaults. PostgreSQL and Redis started by `pnpm db:up` bind to loopback.

See [backend architecture](../../docs/backend.md),
[database](../../docs/database.md), and
[Redis/queue/outbox](../../docs/redis-queue-outbox.md).
