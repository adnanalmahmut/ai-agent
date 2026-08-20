# Staging deployment

`deploy-staging.yml` starts only after the immutable-image publisher succeeds
for `main`. It downloads and validates that publisher run's digest manifest;
it neither checks out nor rebuilds application source.

The `staging` GitHub Environment supplies public variables `VPS_HOST`,
`VPS_USER`, `VPS_SSH_KNOWN_HOSTS`, and `DEPLOYMENT_URL`, plus only the restricted
`VPS_SSH_PRIVATE_KEY` secret. The job never receives database, auth, mail,
OAuth, Redis, or MaxMind credentials.

The forced SSH command invokes `deploy staging <sha>`. The root wrapper holds a
host lock, pulls the SHA-tagged release set, runs `prisma migrate deploy`, and
stops immediately if migration fails. Only then does it update API/readiness,
worker/process status, web, and platform. GitHub finally exercises all three
routes through public HTTPS/Nginx.

Operator verification remains pending until the staging Environment, host,
DNS, certificate, server-local GHCR pull credential (if required), and
root-owned runtime.env exist.
