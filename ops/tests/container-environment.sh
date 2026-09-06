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

# Compose gives the ambient shell environment precedence over `--env-file`, so
# a caller that already exports any of these — CI exports several — would
# silently render its own values instead of the fixture's and turn this suite
# into an assertion about the runner rather than about infra/compose/compose.yaml.
#
# Cleared by the union of the fixture's own names and every name the compose
# file interpolates, not by the fixture's names alone. The compose file
# interpolates several the fixture does not define — GOOGLE_CLIENT_SECRET,
# SMTP_PASSWORD, RESEND_API_KEY, AWS_SECRET_ACCESS_KEY among them — and those
# are exactly the ones a developer is likely to have exported for real. Left
# ambient they would render into the environment this suite prints in full on a
# failure, which would put a live credential into a terminal, a captured log, or
# an agent transcript. Taking the union is also what makes the claim below —
# that everything printed is a fake fixture value — actually true.
unset_names=$(
  {
    while IFS='=' read -r fixture_name _; do
      case "$fixture_name" in
        '' | \#*) continue ;;
      esac
      printf '%s\n' "$fixture_name"
    done <"$runtime"
    grep -oE '\$\{[A-Z][A-Z0-9_]*' infra/compose/compose.yaml | sed 's/^\${//'
  } | sort -u
)
unset_fixture=''
for unset_name in $unset_names; do
  unset_fixture="$unset_fixture -u $unset_name"
done

# Intentionally unquoted: the accumulated `-u NAME` pairs must word-split into
# separate arguments to `env`.
# shellcheck disable=SC2086
env $unset_fixture docker compose --env-file "$runtime" --profile staging --profile migration config --format json >"$rendered"

# `jq -e` exits non-zero on a false result but prints nothing, so a bare
# assertion failure gives no clue which one failed or what the actual value
# was. Every check runs through this helper instead. Dumping in full is safe
# only because of the unset above: every name the compose file interpolates is
# cleared first, so what renders can only be a fixed, fake fixture value.
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
# The worker performs approved agent notifications through the mail driver, so
# it receives the driver, sender and Resend key, plus the non-secret SMTP/SES
# discriminators its config schema needs to boot under those drivers — and
# deliberately not the SMTP or SES credentials, since those drivers cannot
# honour the idempotency contract and the effect fails closed on them.
# `docs/docker-compose.md` states this allowlist; asserted here so a widening
# or a removal is not silent.
assert_jq 'worker gets MAIL_DRIVER' '.services.worker.environment.MAIL_DRIVER == "log"'
assert_jq 'worker gets MAIL_FROM_ADDRESS' '.services.worker.environment.MAIL_FROM_ADDRESS == "no-reply@staging.invalid"'
assert_jq 'worker has a RESEND_API_KEY slot' '.services.worker.environment | has("RESEND_API_KEY")'
assert_jq 'worker has an SMTP_HOST slot' '.services.worker.environment | has("SMTP_HOST")'
assert_jq 'worker has an AWS_REGION slot' '.services.worker.environment | has("AWS_REGION")'
assert_jq 'worker has no SMTP_USER' '.services.worker.environment.SMTP_USER == null'
assert_jq 'worker has no AWS_ACCESS_KEY_ID' '.services.worker.environment.AWS_ACCESS_KEY_ID == null'
assert_jq 'worker has no AWS_SECRET_ACCESS_KEY' '.services.worker.environment.AWS_SECRET_ACCESS_KEY == null'
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
assert_jq 'platform environment allowlist' '.services.platform.environment | keys | sort == ["HOSTNAME", "PLATFORM_API_ORIGIN", "PORT"]'
assert_jq 'platform standalone server port' '.services.platform.environment.PORT == "3001"'
assert_jq 'platform loopback port targets the standalone server directly' '.services.platform.ports == [{"mode":"ingress","host_ip":"127.0.0.1","target":3001,"published":"3001","protocol":"tcp"}]'
assert_jq 'platform healthcheck probes the standalone server port' '.services.platform.healthcheck.test[3] | contains("127.0.0.1:3001/platform/health")'
assert_jq 'geoipupdate environment allowlist' '.services.geoipupdate.environment | keys | sort == ["GEOIPUPDATE_ACCOUNT_ID", "GEOIPUPDATE_EDITION_IDS", "GEOIPUPDATE_FREQUENCY", "GEOIPUPDATE_LICENSE_KEY"]'

echo 'container environment least-privilege invariants: ok'
