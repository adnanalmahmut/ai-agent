#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
valid=$tmp_dir/runtime.env

cat >"$valid" <<'ENV'
NODE_ENV=staging
POSTGRES_USER=app
POSTGRES_PASSWORD=test-only-explicit-password
POSTGRES_DB=app
DATABASE_URL=postgresql://app:test-only-explicit-password@postgres:5432/app
REDIS_URL=redis://redis:6379
APP_ENCRYPTION_KEY=dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=
BETTER_AUTH_SECRET=test-only-better-auth-secret-000000000000
BETTER_AUTH_URL=https://staging.invalid/api/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://staging.invalid
APP_PLATFORM_URL=https://staging.invalid/platform
MAIL_DRIVER=log
MAIL_FROM_ADDRESS=no-reply@staging.invalid
GEOIPUPDATE_ACCOUNT_ID=test-account
GEOIPUPDATE_LICENSE_KEY=test-license
GOOGLE_AUTH_ENABLED=false
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
SMTP_HOST=
SMTP_USER=
SMTP_PASSWORD=
RESEND_API_KEY=
AWS_REGION=
ENV

ops/runtime-preflight.sh staging "$valid" >/dev/null

missing=$tmp_dir/missing.env
grep -v '^POSTGRES_PASSWORD=' "$valid" >"$missing"
if ops/runtime-preflight.sh staging "$missing" >/dev/null 2>&1; then
  echo 'preflight accepted a missing production database password' >&2
  exit 1
fi

empty=$tmp_dir/empty.env
sed 's/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=/' "$valid" >"$empty"
if ops/runtime-preflight.sh staging "$empty" >/dev/null 2>&1; then
  echo 'preflight accepted an empty required secret' >&2
  exit 1
fi

# The realistic wrong key, not a random one: `openssl rand -hex 32` produces 64
# characters that are all valid base64 and decode to 48 bytes, so it survives
# every check the other required values get. The application refuses it at
# boot, after the migration container has already run.
hex_key=$tmp_dir/hex-key.env
sed 's/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff/' \
  "$valid" >"$hex_key"
if ops/runtime-preflight.sh staging "$hex_key" >/dev/null 2>&1; then
  echo 'preflight accepted a hex-encoded encryption key' >&2
  exit 1
fi

short_key=$tmp_dir/short-key.env
sed 's/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=c2hvcnQta2V5/' "$valid" >"$short_key"
if ops/runtime-preflight.sh staging "$short_key" >/dev/null 2>&1; then
  echo 'preflight accepted an encryption key shorter than 32 bytes' >&2
  exit 1
fi

missing_key=$tmp_dir/missing-key.env
grep -v '^APP_ENCRYPTION_KEY=' "$valid" >"$missing_key"
if ops/runtime-preflight.sh staging "$missing_key" >/dev/null 2>&1; then
  echo 'preflight accepted a runtime file with no encryption key' >&2
  exit 1
fi

# The compose file falls back to POSTGRES_PASSWORD=postgres, so a runtime file
# that forgets the value does not fail any non-empty check — it deploys the
# database with a published default credential instead.
fallback_password=$tmp_dir/fallback-password.env
sed 's/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=postgres/' "$valid" >"$fallback_password"
if ops/runtime-preflight.sh staging "$fallback_password" >/dev/null 2>&1; then
  echo 'preflight accepted the compose development database password' >&2
  exit 1
fi

# DATABASE_URL and the POSTGRES_* trio describe the same database twice. When
# they disagree the migration container connects successfully to the wrong one
# and applies a forward-only migration there.
wrong_database=$tmp_dir/wrong-database.env
sed 's#/app?schema=public#/postgres?schema=public#; s#@postgres:5432/app$#@postgres:5432/postgres#' \
  "$valid" >"$wrong_database"
if ops/runtime-preflight.sh staging "$wrong_database" >/dev/null 2>&1; then
  echo 'preflight accepted a DATABASE_URL naming another database' >&2
  exit 1
fi

wrong_role=$tmp_dir/wrong-role.env
sed 's#^DATABASE_URL=postgresql://app:#DATABASE_URL=postgresql://postgres:#' "$valid" >"$wrong_role"
if ops/runtime-preflight.sh staging "$wrong_role" >/dev/null 2>&1; then
  echo 'preflight accepted a DATABASE_URL naming another role' >&2
  exit 1
fi

# A URL with no role at all must be refused as such, rather than being split at
# a separator that is not there and reported as a mismatch.
roleless=$tmp_dir/roleless.env
sed 's#^DATABASE_URL=.*#DATABASE_URL=postgresql://postgres:5432/app#' "$valid" >"$roleless"
if ops/runtime-preflight.sh staging "$roleless" >/dev/null 2>&1; then
  echo 'preflight accepted a DATABASE_URL with no role' >&2
  exit 1
fi

if ops/runtime-preflight.sh production "$valid" >/dev/null 2>&1; then
  echo 'preflight accepted a runtime file for the wrong environment' >&2
  exit 1
fi

echo 'runtime preflight invariants: ok'
