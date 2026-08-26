# Engineering agent map

## Orientation

This is a pnpm monorepo with a NestJS API/worker, Next.js public web app, Vite
operations Platform, PostgreSQL, Redis/BullMQ, and shared UI/i18n packages.
Start with [README.md](README.md), then use [docs/README.md](docs/README.md) as
the knowledge map. Source and executable configuration override prose.

## Sources of truth

- Product/system documentation: `docs/`
- Operator procedures and executable assertions: `ops/`
- Backend runtime contracts: `apps/backend/src/config/`,
  `apps/backend/prisma/schema.prisma`
- Container topology: `docker-compose.yml`, `docker-bake.hcl`
- Delivery behavior: `.github/workflows/`
- Agent semantics: `.agents/`; `.claude/`, `.codex/`, and `.cursor/` are adapters
- Reusable procedures: `.agents/skills/*/SKILL.md`

## Current deployment state

- Staging is the only provisioned/deployed environment.
- Merging to `main` triggers CI, immutable images, and automatic Staging CD.
- Production tooling is prepared target architecture; Production is not
  provisioned and must not be operated.
- Read `docs/deployment-state.md` before delivery or ops work.

## Critical invariants

- PostgreSQL is authoritative; Redis is disposable coordination.
- Accepted async work is committed with an outbox event before BullMQ publish.
- Queue delivery is at-least-once; consumers require durable idempotency.
- API, worker, and migration are separate composition/execution modes.
- Host Nginx is the only trusted proxy; application ports stay loopback-only
  and data networks stay private.
- Platform and organization RBAC are separate domains. Client gates are UX;
  backend authorization is decisive.
- Migrations are forward-only and deployment-gated. Preserve rollback
  compatibility with expand -> migrate/backfill -> switch -> contract later.
- Runtime secrets stay in root-owned `/etc/ai-agent/runtime.env`; never read,
  print, edit, or copy that file.

## Architecture map

- Overall boundaries: `docs/architecture.md`
- Backend and HTTP contracts: `docs/backend.md`, `apps/backend/README.md`
- Frontends and features: `docs/frontend.md`, `docs/feature-inventory.md`
- Auth/RBAC: `docs/authentication-rbac.md`
- Data and async: `docs/database.md`, `docs/redis-queue-outbox.md`
- Runtime configuration: `docs/configuration.md`
- Security: `docs/security.md`
- CI/CD and operations: `docs/ci.md`, `docs/cd.md`, `docs/operations-runbook.md`
- Agent harness: `docs/agent-harness.md`, `.agents/README.md`

## Default engineering loop

Inspect -> understand -> plan -> implement -> validate -> self-review ->
specialized review when risk warrants -> remediate -> revalidate -> synchronize
docs -> prepare PR. Never declare success with a known required-check failure.
Use `.agents/workflows/` after it exists; use direct execution for small tasks.

## Task brief

Normalize substantial work to Goal, Context, Scope, Non-goals, Constraints,
Acceptance Criteria, Validation, Required Evidence, and Git/PR policy. The
canonical template is `.agents/task-brief.md`. Infer safe missing detail from
repository evidence; ask only when a choice materially changes the outcome.

## Skills and roles

- Use a skill for a reusable procedure; load only the relevant `SKILL.md`.
- Use a role for a specialized bounded responsibility and a workflow for
  orchestration across roles.
- Parallelize only independent work. Small changes should not pay a
  multi-agent coordination cost.
- Framework/API questions require current primary documentation. For Next.js,
  also obey the generated `apps/web/AGENTS.md` guidance.

## Validation

Run the narrowest relevant check while iterating, then the required aggregate
checks before handoff. Common commands:

- `pnpm agents:check` for canonical roles, adapters, skills, workflows, hooks,
  local links, secret literals, and deployment-state consistency
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter backend test:e2e`
- `pnpm build`
- `ops/tests/documentation.sh`

Do not use `--fix` in verification. Diagnose failures, fix causes, and rerun.
If an external blocker remains, report the exact command, output, attempts, and
required human decision.

## Documentation obligations

Update the narrowest owning doc in the same change when behavior, configuration,
features, security boundaries, deployment, or runbooks change. Do not pin
volatile test counts. Keep current deployed state separate from future target
architecture. Use ADRs and execution plans only under the conventions in
`docs/decisions/README.md` and `docs/exec-plans/README.md`.

## Git and pull requests

- Preserve unrelated user changes and keep diffs focused.
- Never force-push, rewrite `main`, push directly to `main`, merge a PR, or
  enable auto-merge.
- Stage explicit paths only. Every PR describes goal, changes, architecture
  impact, validation, risks/tradeoffs, dependency/base, and follow-up work.
- Leave PRs open for human review. A merge is a live Staging deployment action.
- One session may run a bounded PR train: at most 3 open implementation PRs by
  default, 4 supported. Stack only on a real code/data/API dependency; prefer
  siblings on a shared ancestor. Resume with `pnpm agents:resume` and treat a
  compaction as a process restart, never as continuity of memory. The contract is
  [the PR train workflow](.agents/workflows/pr-train.md).

## Security and operations

- Never expose secrets, tokens, cookies, session IDs, private keys, or
  environment dumps in prompts, output, logs, commits, or PRs.
- Do not modify GitHub Environment values/secrets, the live Staging VPS,
  `/etc/ai-agent/runtime.env`, DNS/TLS, or backups.
- Do not provision or operate Production or manually deploy any environment.
- Ask before destructive commands (`rm -rf`, reset, prune, volume teardown).
- Treat `.agents/policies/` as canonical detail for engineering, safety, and
  delivery boundaries; tool-specific adapters may only delegate to it.
