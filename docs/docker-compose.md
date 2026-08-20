# Docker Compose

The repository has exactly one root `docker-compose.yml`. Profiles select
development, test, staging, production, and one-shot migration behavior; there
are no environment-specific Compose files.

Production/staging run PostgreSQL, Redis, API, worker, web, platform, and
geoipupdate. API/worker share the backend image. Named volumes persist
PostgreSQL, Redis AOF, and GeoIP data. Data networking is internal; application
host ports bind to `127.0.0.1`; worker/database/Redis expose no public port.

`runtime.env` is an interpolation input to Compose, not a blanket container
environment. Explicit service allowlists keep API-only authentication, mail,
HTTP, GeoIP, and rate-limit values out of the worker; the migration process
receives only `DATABASE_URL`. The deployment wrapper runs a non-printing
preflight before starting any production service.

Never use volume-removing teardown or volume prune commands. Migrations run
through the migration target before service updates, not in API startup.
Container images run non-root where practical and `.dockerignore` excludes
environment files, keys, certificates, backups, and development output.

See [`ops/container-foundation.md`](../ops/container-foundation.md) for profiles,
health checks, environment boundaries, and validation commands.
