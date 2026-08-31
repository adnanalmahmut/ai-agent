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
APP_ENCRYPTION_ACTIVE_KEY_VERSION=v2
APP_ENCRYPTION_DECRYPT_KEYS=v1=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=
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

# A non-canonical encoding of the exact same 32 bytes: unused bits in the last
# base64 character are set even though they cannot affect the decoded value.
# `base64 -d` accepts it and produces the right byte count, so only an
# explicit canonical round trip catches it — the same check the TypeScript
# config performs, without which preflight would approve a value the
# application then refuses at boot.
noncanonical_key=$tmp_dir/noncanonical-key.env
sed 's/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGV=/' \
  "$valid" >"$noncanonical_key"
if ops/runtime-preflight.sh staging "$noncanonical_key" >/dev/null 2>&1; then
  echo 'preflight accepted a non-canonical base64 encryption key' >&2
  exit 1
fi

missing_key=$tmp_dir/missing-key.env
grep -v '^APP_ENCRYPTION_KEY=' "$valid" >"$missing_key"
if ops/runtime-preflight.sh staging "$missing_key" >/dev/null 2>&1; then
  echo 'preflight accepted a runtime file with no encryption key' >&2
  exit 1
fi

missing_key_version=$tmp_dir/missing-key-version.env
grep -v '^APP_ENCRYPTION_ACTIVE_KEY_VERSION=' "$valid" >"$missing_key_version"
if ops/runtime-preflight.sh staging "$missing_key_version" >/dev/null 2>&1; then
  echo 'preflight accepted a runtime file with no active encryption key version' >&2
  exit 1
fi

# The same corpus the application's own config spec rejects, rather than one
# value that is malformed in several ways at once. `V2 active` alone was
# satisfied by a preflight that merely rejected spaces, which would have let the
# shell drift into accepting versions the container then refuses at boot -- the
# exact split this suite exists to prevent. Each case below is malformed in
# exactly one way.
for invalid_version in 'V2' '-v2' 'v2-' 'v2/active' 'v 2' '.v2' 'v2.' \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; do
  invalid_key_version=$tmp_dir/invalid-key-version.env
  sed "s#^APP_ENCRYPTION_ACTIVE_KEY_VERSION=.*#APP_ENCRYPTION_ACTIVE_KEY_VERSION=$invalid_version#" \
    "$valid" >"$invalid_key_version"
  if ops/runtime-preflight.sh staging "$invalid_key_version" >/dev/null 2>&1; then
    echo "preflight accepted an invalid active encryption key version: $invalid_version" >&2
    exit 1
  fi
done

# ...and the control: a version that is merely unusual must still be accepted,
# or the loop above would pass against a preflight that rejects everything.
for valid_version in 'v2' 'a' 'legacy-2025' 'v1.2_3' \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; do
  accepted_version=$tmp_dir/accepted-key-version.env
  sed -e "s#^APP_ENCRYPTION_ACTIVE_KEY_VERSION=.*#APP_ENCRYPTION_ACTIVE_KEY_VERSION=$valid_version#" \
    -e 's#^APP_ENCRYPTION_DECRYPT_KEYS=.*#APP_ENCRYPTION_DECRYPT_KEYS=#' \
    "$valid" >"$accepted_version"
  ops/runtime-preflight.sh staging "$accepted_version" >/dev/null 2>&1 || {
    echo "preflight refused a valid active encryption key version: $valid_version" >&2
    exit 1
  }
done

# The decrypt-only list is optional, and its normal state on a first rollout is
# to be absent entirely. Refusing that would refuse a correct host -- and the
# refusal `value_for` produces talks about the line occurring more than once,
# which sends an operator looking for a duplicate that is not there.
absent_decrypt_keys=$tmp_dir/absent-decrypt-keys.env
grep -v '^APP_ENCRYPTION_DECRYPT_KEYS=' "$valid" >"$absent_decrypt_keys"
ops/runtime-preflight.sh staging "$absent_decrypt_keys" >/dev/null 2>&1 || {
  echo 'preflight refused a runtime file with no decrypt-only key line' >&2
  exit 1
}

# Present but empty is equally normal.
empty_decrypt_keys=$tmp_dir/empty-decrypt-keys.env
sed 's#^APP_ENCRYPTION_DECRYPT_KEYS=.*#APP_ENCRYPTION_DECRYPT_KEYS=#' \
  "$valid" >"$empty_decrypt_keys"
ops/runtime-preflight.sh staging "$empty_decrypt_keys" >/dev/null 2>&1 || {
  echo 'preflight refused an empty decrypt-only key list' >&2
  exit 1
}

# Duplication remains an error: the container would silently take one of them.
duplicate_decrypt_keys=$tmp_dir/duplicate-decrypt-keys.env
{
  cat "$valid"
  printf 'APP_ENCRYPTION_DECRYPT_KEYS=\n'
} >"$duplicate_decrypt_keys"
if ops/runtime-preflight.sh staging "$duplicate_decrypt_keys" >/dev/null 2>&1; then
  echo 'preflight accepted a duplicated decrypt-only key line' >&2
  exit 1
fi

duplicate_active_version=$tmp_dir/duplicate-active-version.env
sed 's#^APP_ENCRYPTION_DECRYPT_KEYS=.*#APP_ENCRYPTION_DECRYPT_KEYS=v2=IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=#' \
  "$valid" >"$duplicate_active_version"
if ops/runtime-preflight.sh staging "$duplicate_active_version" >/dev/null 2>&1; then
  echo 'preflight accepted the active encryption version as decrypt-only' >&2
  exit 1
fi

duplicate_key_material=$tmp_dir/duplicate-key-material.env
sed 's#^APP_ENCRYPTION_DECRYPT_KEYS=.*#APP_ENCRYPTION_DECRYPT_KEYS=v1=dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=#' \
  "$valid" >"$duplicate_key_material"
if ops/runtime-preflight.sh staging "$duplicate_key_material" >/dev/null 2>&1; then
  echo 'preflight accepted active key material under a decrypt-only version' >&2
  exit 1
fi

malformed_decrypt_key=$tmp_dir/malformed-decrypt-key.env
sed 's#^APP_ENCRYPTION_DECRYPT_KEYS=.*#APP_ENCRYPTION_DECRYPT_KEYS=v1=not-base64#' \
  "$valid" >"$malformed_decrypt_key"
if ops/runtime-preflight.sh staging "$malformed_decrypt_key" >/dev/null 2>&1; then
  echo 'preflight accepted malformed decrypt-only key material' >&2
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
