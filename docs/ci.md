# Continuous integration

`.github/workflows/ci.yml` is verify-only, read-only, and receives no staging or
production secrets.

- Backend: Compose/static security assertions, frozen install, shared package
  build, Prisma validate/generate/current-client check, workspace typecheck,
  lint, unit tests, migrations into real PostgreSQL, E2E against real
  PostgreSQL/Redis, and production build.
- Platform: install/packages, workspace typecheck, lint, unit/component tests,
  and Vite build.
- Web: install/packages, lint, tests, and Next production build.
- Containers: Buildx Bake builds every exact production target without a push,
  then loads the backend runtime and migration targets, applies migrations to a
  real PostgreSQL container, and proves API liveness while Redis is absent.

CI never repairs source (`--fix` is absent), publishes, deploys, or calls an
external provider. Static and dynamic ops tests enforce service environment
allowlists, runtime preflight, SSH command boundaries, release-manifest
lineage, exact-digest rollback, and restore-drill isolation before real VPS
infrastructure exists.
