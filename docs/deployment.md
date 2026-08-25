# Deployment

## Current state

Staging is provisioned and deploys automatically after a merge to `main`
passes CI and immutable image publishing. Production is not provisioned. The
Production workflow and host tooling below define a future contract and must
not be dispatched or operated until an operator records provisioning evidence
in [the deployment-state document](deployment-state.md).

## GitHub Environment names

Staging uses the values below. A future Production Environment must use the
same names with independent values when it is provisioned.

| Kind | Name | Purpose |
|---|---|---|
| Variable | `VPS_HOST` | environment static IP/hostname |
| Variable | `VPS_USER` | must be `deploy` |
| Variable | `VPS_SSH_KNOWN_HOSTS` | pinned host-key line(s) |
| Variable | `DEPLOYMENT_URL` | public HTTPS origin |
| Secret | `VPS_SSH_PRIVATE_KEY` | environment-specific restricted key |

`GITHUB_TOKEN` is job-scoped and needs no operator value. Production should
require reviewers; staging should remain automatic if that is the desired flow.

## VPS runtime names

Install `/etc/ai-agent/runtime.env` as `root:root 0600`. The deploy user cannot
read it. It contains names for
PostgreSQL (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`),
Redis (`REDIS_URL` and bounded connection settings), Better Auth
(`BETTER_AUTH_SECRET`, URL/origins and optional rate toggle), the control-plane
master key (`APP_ENCRYPTION_KEY`), app URLs/ports and shutdown settings,
optional Google OAuth, selected mail provider credentials, queue/outbox
settings, rate-limit settings, and MaxMind updater credentials.
The authoritative names-only template is
[`ops/environments/runtime.env.example`](../ops/environments/runtime.env.example).

The wrapper passes this path to Compose for interpolation, but the Compose file
does not use `env_file`. Each service has an explicit environment allowlist:
the API receives HTTP/auth/mail/GeoIP/rate-limit settings; the worker receives
only app/database/Redis/queue/outbox/log settings plus `APP_ENCRYPTION_KEY`,
which it needs because a background execution resolves the same provider
credentials the API does; the migration process receives only `DATABASE_URL`; web, platform, and geoipupdate receive only their
own settings. Image repositories are fixed in the root wrapper and image
references are constructed from validated digest hex values, never read from
`runtime.env`.

Release images are pulled sequentially in the order platform → web → backend →
migrate. Worker reuses the backend image. This bounds memory and disk-I/O
pressure on small Lightsail hosts during layer download and extraction instead
of asking Compose to pull every large image concurrently.

The remaining order is PostgreSQL/Redis/GeoIP bootstrap → migration → API → API
readiness → worker → worker status → web and platform → complete internal
health → public HTTPS smoke. Only after success does the wrapper atomically
rotate root-only `CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json`, each
containing the source SHA and four OCI digests. Live operator commands are in
the staging/production ops docs.

## One-time operator step before the Knowledge release

The PostgreSQL image changed from `postgres:16-alpine` to
`pgvector/pgvector:pg16`. Knowledge retrieval stores embeddings in a `vector`
column and the extension is absent from the Alpine image; pgvector publishes no
Alpine variant, so this is a Debian image where the previous one was musl.

The data directory is binary-compatible for the same PostgreSQL major, so the
container starts and serves normally. What is not compatible is text collation:
musl and glibc order text differently under the same locale name, and musl
records no collation version — so PostgreSQL emits no mismatch warning, and
every existing text btree index is silently left in an order the new libc does
not agree with. The symptom is wrong results from range and equality scans, not
an error.

On an environment with an existing PostgreSQL volume, an operator must run this
once against each database after the first start on the new image, before
traffic is admitted:

```sql
REINDEX DATABASE <database>;
ALTER DATABASE <database> REFRESH COLLATION VERSION;
```

The application does not and must not perform this. It is a privileged,
long-running, one-time repair on live data, and a service that reindexed its
own database at boot would do it on every rollback and every restart.

A fresh volume needs nothing: there is no index built under the other libc.
The `postgres-test` service keeps its data in tmpfs, so it is unaffected.
