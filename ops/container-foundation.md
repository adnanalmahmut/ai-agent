# Container foundation

The repository has one Compose model: `docker-compose.yml`. Profiles select
the process set without overlay files:

- `development`: PostgreSQL and Redis on loopback for local development.
- `test`: isolated, disposable PostgreSQL and Redis on loopback.
- `staging` and `production`: API, worker, web, platform, databases, and the
  MaxMind database updater.
- `migration`: the one-shot Prisma migration image used by deployment.

Only the host Nginx process is intended to accept public traffic. Compose binds
API, web, platform, PostgreSQL, and Redis host ports to `127.0.0.1`; the worker
has no port. PostgreSQL and Redis are attached only to the internal `data`
network. Persistent state lives in the `postgres_data`, `redis_data`, and
`geoip_data` named volumes.

The Backend API and Worker use the same image and select `dist/src/main` or
`dist/src/worker` as their command. The migration target includes Prisma CLI
and committed migrations; migrations do not run in either application startup.

## Local verification

```bash
docker compose --profile development config
docker compose --profile test config
docker compose --profile staging --profile migration config
docker compose build backend web platform migrate
```

The staging/production runtime file is server-local. Start Compose with an
explicit path; deployment automation will enforce this convention:

```bash
docker compose \
  --env-file /etc/ai-agent/runtime.env \
  --profile staging \
  up -d
```

Never use `docker compose down -v`, `docker volume prune`, or
`docker system prune --volumes`; those commands can destroy persistent state.
