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

if ops/runtime-preflight.sh production "$valid" >/dev/null 2>&1; then
  echo 'preflight accepted a runtime file for the wrong environment' >&2
  exit 1
fi

echo 'runtime preflight invariants: ok'
