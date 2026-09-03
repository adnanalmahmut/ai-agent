# Engineering agent guide

## Start here

Read [README.md](README.md) and use [docs/README.md](docs/README.md) to find the
owning documentation. Source and executable configuration override prose.

This is a pnpm monorepo with two Next.js applications, a NestJS API/worker/CLI,
PostgreSQL, Redis/BullMQ, and shared UI and i18n packages.

## Sources of truth

- Product and system behavior: `docs/` plus the relevant source and tests
- Backend runtime contracts: `apps/backend/src/infrastructure/config/` and
  `apps/backend/prisma/schema.prisma`
- Container topology: `docker-compose.yml` and `docker-bake.hcl`
- Delivery behavior: `.github/workflows/` and `ops/`
- Agent policies, roles, workflows, and skills: `.agents/`

## Working rules

- Preserve unrelated changes and keep diffs focused.
- Do not change runtime behavior while performing documentation-only work.
- Update the narrowest owning document when behavior, configuration, security,
  deployment, or operator procedure changes. Prefer links over duplication.
- Treat PostgreSQL as business authority and Redis as disposable coordination.
- Preserve transactional outbox, at-least-once delivery, durable idempotency,
  tenant isolation, and separate API/worker/migration composition roots.
- Client-side permission gates are user experience only; backend authorization
  is decisive. Platform and organization roles are separate domains.
- Keep migrations forward-only and rollback-compatible through
  expand/migrate/switch/contract changes.
- For substantial work, use [.agents/task-brief.md](.agents/task-brief.md).
- Use a focused `.agents/workflows/` procedure when applicable; load skills
  only when relevant.

## Validation

Run the narrowest relevant check while iterating, then the aggregate checks
appropriate to the change:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter backend test:e2e
pnpm build
ops/tests/documentation.sh
```

Do not use `--fix` as verification. Do not declare completion with a known
required-check failure.

## Delivery and safety

- Read [docs/deployment-state.md](docs/deployment-state.md) before delivery or
  operations work. Staging is the only provisioned environment.
- Never push directly to `main`, force-push, merge a PR, enable auto-merge,
  manually deploy, or operate Production.
- A merge to `main` is a live Staging deployment action.
- Never read, print, edit, or copy `/etc/ai-agent/runtime.env`, and never expose
  secrets, tokens, cookies, session IDs, private keys, or environment dumps.
- Do not modify GitHub Environment values, the Staging VPS, DNS/TLS, or backups.
- Ask before destructive commands such as recursive deletion, reset, prune, or
  volume teardown.
- Treat `.agents/policies/` as canonical for detailed engineering, delivery,
  and safety constraints.
