# Docker Compose

The repository has one Compose model in `infra/compose/`: a shared
`compose.yaml` plus one overlay per composition.

| File                  | Composition                       | Profiles                             |
| --------------------- | --------------------------------- | ------------------------------------ |
| `compose.yaml`        | shared, never used alone          | —                                    |
| `compose.dev.yaml`    | development                       | `development`                        |
| `compose.test.yaml`   | test and CI                       | `test`                               |
| `compose.deploy.yaml` | staging, production and migration | `staging`, `production`, `migration` |

The shared file holds what is true of PostgreSQL and Redis everywhere. Each
overlay holds what is true of one composition only, so no setting is stated
twice and none reaches a composition it was not written for: the development
credential fallbacks are in `compose.dev.yaml`, which a deployment never loads,
and the throwaway `postgres-test`/`redis-test` are in `compose.test.yaml`, which
a deployment never loads either.

Repository commands reach Compose through `infra/scripts/compose.sh`, which
resolves the repository root from its own location, picks the overlay from the
requested profile, and derives the project name from the composition —
`ai-agent` for development and deployment, `ai-agent-test` for test. It refuses
arguments that would substitute a file or rename the project, requests that
combine two compositions, unknown profiles, and the volume- and image-removing
teardown flags, so a caller cannot reach a second project's networks and volumes
through it; use `docker compose` directly when one of those is genuinely
intended. The root `pnpm db:up`, `db:down`, and `db:logs` scripts use it
unchanged — selecting an overlay needs no new argument — and the backend
workspace aliases delegate to them. Host and deployment tooling under `ops/`
keeps its own invocation, because it runs against the installed bundle rather
than the repository.

A test composition cannot share anything with a developer's. Its own project
name gives it its own container, network, and volume names, and the shared
`postgres` and `redis` do not carry the `test` profile, so a CI run cannot join
`ai-agent_edge` or write to `ai-agent_postgres_data`. The test host ports,
`5433` and `6378`, are unchanged and remain the contract the backend suite
connects to.

A machine that started the test databases before the split has them as
`ai-agent-postgres-test-1` and `ai-agent-redis-test-1` in the `ai-agent`
project. They keep running and are now orphans there: `--profile test` addresses
`ai-agent-test` instead, and starting it while the old pair holds `5433`/`6378`
fails on the port. Remove them once —
`docker rm -f ai-agent-postgres-test-1 ai-agent-redis-test-1` — and let
`--profile test up` recreate them under the new project. Nothing is lost; those
containers keep their data in tmpfs and own no volume. The development
`postgres` and `redis` are unaffected and are not recreated: their Compose
service hashes are unchanged by the split.

Production/staging run PostgreSQL, Redis, API, worker, web, platform, and
geoipupdate. API/worker share the backend image. Named volumes persist
PostgreSQL, Redis AOF, and GeoIP data. Data networking is internal; application
host ports bind to `127.0.0.1`; worker/database/Redis expose no public port.

`runtime.env` is an interpolation input to Compose, not a blanket container
environment. Explicit service allowlists keep API-only authentication, HTTP,
GeoIP, and rate-limit values out of the worker; the migration process receives
only `DATABASE_URL`. The worker does receive the mail driver values
(`MAIL_DRIVER`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`, `MAIL_TIMEOUT_MS`,
`RESEND_API_KEY`), because it is the process that performs an approved agent
notification, plus the non-secret SMTP and SES discriminators (`SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `AWS_REGION`) so it boots under those drivers too.
The SMTP and SES credentials are not passed to it: those drivers cannot honour
the idempotency contract, and the effect fails closed on them before any send. The deployment wrapper runs a non-printing
preflight before starting any production service.

Never use volume-removing teardown or volume prune commands. Migrations run
through the migration target before service updates, not in API startup.
Container images run non-root where practical and `.dockerignore` excludes
environment files, keys, certificates, backups, and development output.

See [`ops/container-foundation.md`](../ops/container-foundation.md) for profiles,
health checks, environment boundaries, and validation commands.
