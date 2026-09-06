# Container foundation

The repository has one Compose model in `infra/compose/`: the shared
`compose.yaml`, plus `compose.dev.yaml`, `compose.test.yaml`, and
`compose.deploy.yaml`. `infra/scripts/compose.sh` merges the shared file with
exactly one overlay, chosen from the requested profile, and no caller names a
file itself. Profiles select the process set:

- `development`: PostgreSQL and Redis on loopback for local development, under
  the `ai-agent` project.
- `test`: isolated, disposable PostgreSQL and Redis on loopback, under the
  separate `ai-agent-test` project, so no container, network, or volume name
  collides with a developer's.
- `staging` and `production`: API, worker, web, platform, databases, and the
  MaxMind database updater.
- `migration`: the one-shot Prisma migration image used by deployment.

Only the host Nginx process is intended to accept public traffic. Compose binds
API, web, platform, PostgreSQL, and Redis host ports to `127.0.0.1`; the worker
has no port. PostgreSQL and Redis are attached only to the internal `data`
network. Persistent state lives in the `postgres_data`, `redis_data`, and
`geoip_data` named volumes.

The Backend API and Worker use the same image and select `dist/src/api/main` or
`dist/src/workers/main` as their command. The migration target includes Prisma
CLI and committed migrations; migrations do not run in either application
startup.

## Local verification

```bash
infra/scripts/compose.sh --profile development config
infra/scripts/compose.sh --profile test config
infra/scripts/compose.sh --profile staging --profile migration config
infra/scripts/compose.sh --profile staging build backend web platform migrate
```

The build command names a profile because the application services live in the
deployment overlay: without one the wrapper assembles the development
composition, which does not define them.

The staging/production runtime file is server-local. Start Compose with an
explicit path; deployment automation will enforce this convention. Compose
uses the file only for interpolation, and each service receives an explicit
allowlist rather than the complete file:

```bash
docker compose \
  --file /opt/ai-agent/docker-compose.yml \
  --file /opt/ai-agent/docker-compose.deploy.yml \
  --env-file /etc/ai-agent/runtime.env \
  --profile staging \
  up -d
```

Before any staging or production startup, run
`infra/deploy/runtime-preflight.sh <environment> /etc/ai-agent/runtime.env`. It validates
required values without sourcing the file or printing their contents, and
refuses the compose development database password and a `DATABASE_URL` that
names a different role or database than the `POSTGRES_*` values.

The two compose files installed at `/opt/ai-agent/docker-compose.yml` and
`/opt/ai-agent/docker-compose.deploy.yml` are part of the
versioned host bundle, so they are installed and recorded by
`infra/deploy/install-host-bundle.sh` rather than copied by hand; the deploy
wrapper refuses a release whose recorded digest no longer matches. See
[the host bundle document](../docs/host-bundle.md).

Never use `docker compose down -v`, `docker volume prune`, or
`docker system prune --volumes`; those commands can destroy persistent state.
