#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

command -v docker >/dev/null 2>&1 || {
  echo 'docker unavailable: rendered container environment checks skipped'
  exit 0
}
command -v jq >/dev/null 2>&1 || {
  echo 'jq is required for rendered container environment checks' >&2
  exit 1
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
runtime=$tmp_dir/runtime.env
rendered=$tmp_dir/compose.json

cat >"$runtime" <<'ENV'
NODE_ENV=staging
POSTGRES_USER=app
POSTGRES_PASSWORD=test-only-database-password
POSTGRES_DB=app
DATABASE_URL=postgresql://app:test-only-database-password@postgres:5432/app
REDIS_URL=redis://redis:6379
APP_ENCRYPTION_KEY=dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=
APP_ENCRYPTION_ACTIVE_KEY_VERSION=v1
APP_ENCRYPTION_DECRYPT_KEYS=v0=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=
BETTER_AUTH_SECRET=test-only-better-auth-secret-000000000000
BETTER_AUTH_URL=https://staging.invalid/api/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://staging.invalid
APP_PLATFORM_URL=https://staging.invalid/platform
MAIL_DRIVER=log
MAIL_FROM_ADDRESS=no-reply@staging.invalid
GOOGLE_AUTH_ENABLED=false
GEOIPUPDATE_ACCOUNT_ID=test-account
GEOIPUPDATE_LICENSE_KEY=test-license
ENV

docker compose --env-file "$runtime" --profile staging --profile migration config --format json >"$rendered"

jq -e '.services.backend.environment.APP_PORT == "3002"' "$rendered" >/dev/null
jq -e '.services.backend.depends_on.redis == null' "$rendered" >/dev/null
jq -e '.services.worker.environment.BETTER_AUTH_SECRET == null' "$rendered" >/dev/null
jq -e '.services.worker.environment.GOOGLE_CLIENT_SECRET == null' "$rendered" >/dev/null
jq -e '.services.worker.environment.SMTP_PASSWORD == null' "$rendered" >/dev/null
jq -e '.services.worker.environment.RATE_LIMIT_ENABLED == null' "$rendered" >/dev/null
# The control-plane master key decrypts every stored provider credential. The
# worker legitimately needs it — a background execution resolves the same
# credentials the API does — but the migration process, web, and platform do
# not, and `docs/deployment.md` states that allowlist as a security property.
# Asserted in both directions so neither a removal nor a widening is silent.
jq -e '.services.backend.environment.APP_ENCRYPTION_KEY == "dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU="' "$rendered" >/dev/null
jq -e '.services.worker.environment.APP_ENCRYPTION_KEY == "dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU="' "$rendered" >/dev/null
jq -e '.services.migrate.environment.APP_ENCRYPTION_KEY == null' "$rendered" >/dev/null
jq -e '.services.backend.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == "v1"' "$rendered" >/dev/null
jq -e '.services.worker.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == "v1"' "$rendered" >/dev/null
jq -e '.services.migrate.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == null' "$rendered" >/dev/null
jq -e '.services.backend.environment.APP_ENCRYPTION_DECRYPT_KEYS == "v0=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI="' "$rendered" >/dev/null
jq -e '.services.worker.environment.APP_ENCRYPTION_DECRYPT_KEYS == "v0=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI="' "$rendered" >/dev/null
jq -e '.services.migrate.environment.APP_ENCRYPTION_DECRYPT_KEYS == null' "$rendered" >/dev/null

jq -e '.services.migrate.environment | keys == ["DATABASE_URL"]' "$rendered" >/dev/null
jq -e '.services.web.environment | keys | sort == ["HOSTNAME", "PORT"]' "$rendered" >/dev/null
jq -e '.services.platform.environment == null' "$rendered" >/dev/null
jq -e '.services.geoipupdate.environment | keys | sort == ["GEOIPUPDATE_ACCOUNT_ID", "GEOIPUPDATE_EDITION_IDS", "GEOIPUPDATE_FREQUENCY", "GEOIPUPDATE_LICENSE_KEY"]' "$rendered" >/dev/null

echo 'container environment least-privilege invariants: ok'
