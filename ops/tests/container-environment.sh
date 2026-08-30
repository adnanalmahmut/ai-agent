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

# `jq -e` exits non-zero on a false result but prints nothing, so a bare
# assertion failure gives no clue which one failed or what the actual value
# was. Every check runs through this helper instead, which is safe to dump in
# full: everything here is a fixed, fake fixture value, never a real secret.
assert_jq() {
  description=$1
  filter=$2
  jq -e "$filter" "$rendered" >/dev/null || {
    echo "container environment check failed: $description" >&2
    echo "filter: $filter" >&2
    echo 'rendered backend/worker/migrate environment:' >&2
    jq '{backend: .services.backend.environment, worker: .services.worker.environment, migrate: .services.migrate.environment}' "$rendered" >&2
    exit 1
  }
}

assert_jq 'backend APP_PORT' '.services.backend.environment.APP_PORT == "3002"'
assert_jq 'backend does not depend_on redis directly' '.services.backend.depends_on.redis == null'
assert_jq 'worker has no BETTER_AUTH_SECRET' '.services.worker.environment.BETTER_AUTH_SECRET == null'
assert_jq 'worker has no GOOGLE_CLIENT_SECRET' '.services.worker.environment.GOOGLE_CLIENT_SECRET == null'
assert_jq 'worker has no SMTP_PASSWORD' '.services.worker.environment.SMTP_PASSWORD == null'
assert_jq 'worker has no RATE_LIMIT_ENABLED' '.services.worker.environment.RATE_LIMIT_ENABLED == null'
# The control-plane master key decrypts every stored provider credential. The
# worker legitimately needs it — a background execution resolves the same
# credentials the API does — but the migration process, web, and platform do
# not, and `docs/deployment.md` states that allowlist as a security property.
# Asserted in both directions so neither a removal nor a widening is silent.
assert_jq 'backend gets APP_ENCRYPTION_KEY' '.services.backend.environment.APP_ENCRYPTION_KEY == "dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU="'
assert_jq 'worker gets APP_ENCRYPTION_KEY' '.services.worker.environment.APP_ENCRYPTION_KEY == "dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU="'
assert_jq 'migrate has no APP_ENCRYPTION_KEY' '.services.migrate.environment.APP_ENCRYPTION_KEY == null'
assert_jq 'backend gets APP_ENCRYPTION_ACTIVE_KEY_VERSION' '.services.backend.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == "v1"'
assert_jq 'worker gets APP_ENCRYPTION_ACTIVE_KEY_VERSION' '.services.worker.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == "v1"'
assert_jq 'migrate has no APP_ENCRYPTION_ACTIVE_KEY_VERSION' '.services.migrate.environment.APP_ENCRYPTION_ACTIVE_KEY_VERSION == null'
assert_jq 'backend gets APP_ENCRYPTION_DECRYPT_KEYS' '.services.backend.environment.APP_ENCRYPTION_DECRYPT_KEYS == "v0=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI="'
assert_jq 'worker gets APP_ENCRYPTION_DECRYPT_KEYS' '.services.worker.environment.APP_ENCRYPTION_DECRYPT_KEYS == "v0=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI="'
assert_jq 'migrate has no APP_ENCRYPTION_DECRYPT_KEYS' '.services.migrate.environment.APP_ENCRYPTION_DECRYPT_KEYS == null'

assert_jq 'migrate environment is DATABASE_URL only' '.services.migrate.environment | keys == ["DATABASE_URL"]'
assert_jq 'web environment allowlist' '.services.web.environment | keys | sort == ["HOSTNAME", "PORT"]'
assert_jq 'platform has no environment block' '.services.platform.environment == null'
assert_jq 'geoipupdate environment allowlist' '.services.geoipupdate.environment | keys | sort == ["GEOIPUPDATE_ACCOUNT_ID", "GEOIPUPDATE_EDITION_IDS", "GEOIPUPDATE_FREQUENCY", "GEOIPUPDATE_LICENSE_KEY"]'

echo 'container environment least-privilege invariants: ok'
