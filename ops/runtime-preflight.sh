#!/bin/sh
set -eu

die() {
  echo "runtime preflight failed: $*" >&2
  exit 64
}

[ "$#" -eq 2 ] || die 'usage: runtime-preflight.sh <staging|production> <runtime-env-file>'
expected_environment=$1
runtime_file=$2

case "$expected_environment" in
  staging | production) ;;
  *) die 'environment must be staging or production' ;;
esac

[ -r "$runtime_file" ] || die 'runtime environment file is not readable'

value_for() {
  key=$1
  count=$(grep -c "^${key}=" "$runtime_file" || true)
  [ "$count" -eq 1 ] || die "$key must occur exactly once"
  sed -n "s/^${key}=//p" "$runtime_file" | sed 's/[[:space:]]*$//'
}

require_nonempty() {
  key=$1
  value=$(value_for "$key")
  [ -n "$value" ] || die "$key is missing or empty"
}

# For names the application defaults rather than requires. `value_for` treats a
# missing line as an error, which is right for a required name and wrong here:
# an absent APP_ENCRYPTION_DECRYPT_KEYS is its normal state -- no older key is
# configured -- and refusing it would refuse a correct host with a message about
# duplication. A line that is present more than once is still an error, because
# the container would silently take one of them.
optional_value_for() {
  key=$1
  count=$(grep -c "^${key}=" "$runtime_file" || true)
  [ "$count" -le 1 ] || die "$key must occur at most once"
  [ "$count" -eq 1 ] || return 0
  value_for "$key"
}

required='NODE_ENV
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
DATABASE_URL
REDIS_URL
APP_ENCRYPTION_KEY
APP_ENCRYPTION_ACTIVE_KEY_VERSION
BETTER_AUTH_SECRET
BETTER_AUTH_URL
BETTER_AUTH_TRUSTED_ORIGINS
APP_PLATFORM_URL
MAIL_DRIVER
MAIL_FROM_ADDRESS
GEOIPUPDATE_ACCOUNT_ID
GEOIPUPDATE_LICENSE_KEY'

for key in $required; do
  require_nonempty "$key"
done

[ "$(value_for NODE_ENV)" = "$expected_environment" ] || die 'NODE_ENV does not match the host environment'

# The master key is the one required value with a checkable shape, and the one
# whose failure is most expensive to discover late. The application rejects
# anything that does not base64-decode to exactly 32 bytes, and it does so at
# ConfigModule init — which the deploy sequence reaches only after the
# migration container has already run. `openssl rand -hex 32` is the easy
# mistake: 64 hex characters are all valid base64, so a non-empty check passes
# and the value decodes to 48 bytes. Caught here it is a preflight refusal;
# caught at boot it is a half-applied release.
validate_encryption_key() {
  variable_name=$1
  encoded_key=$2
  [ "${#encoded_key}" -eq 44 ] ||
    die "$variable_name must be 32 bytes encoded as canonical base64"
  [ "${encoded_key#${encoded_key%?}}" = '=' ] ||
    die "$variable_name must be 32 bytes encoded as canonical base64"
  encoded_body=${encoded_key%?}
  case "$encoded_body" in
    '' | *[!A-Za-z0-9+/]*)
      die "$variable_name must be 32 bytes encoded as canonical base64"
      ;;
  esac
  encoded_key_bytes=$(printf '%s' "$encoded_key" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]') ||
    die "$variable_name must be 32 bytes encoded as canonical base64"
  [ "$encoded_key_bytes" = '32' ] ||
    die "$variable_name must be 32 bytes encoded as canonical base64"
  # A non-canonical base64 string (unused padding bits set, e.g. from a
  # hand-edited value) can still decode to 32 bytes yet re-encode to a
  # different string. The TypeScript config requires the exact canonical
  # round trip, so preflight must too, or a value it approves can still crash
  # the application at boot. The decoded bytes are never held in a shell
  # variable — only piped straight back through `base64` — because raw binary
  # can contain a NUL byte a POSIX shell string cannot hold.
  recoded_key=$(printf '%s' "$encoded_key" | base64 -d 2>/dev/null | base64 | tr -d '\n')
  [ "$recoded_key" = "$encoded_key" ] ||
    die "$variable_name must be 32 bytes encoded as canonical base64"
}

valid_key_version() {
  version=$1
  [ -n "$version" ] && [ "${#version}" -le 64 ] || return 1
  case "$version" in
    *[!a-z0-9._-]* | [._-]* | *[._-]) return 1 ;;
  esac
}

encryption_key=$(value_for APP_ENCRYPTION_KEY)
validate_encryption_key APP_ENCRYPTION_KEY "$encryption_key"

active_key_version=$(value_for APP_ENCRYPTION_ACTIVE_KEY_VERSION)
valid_key_version "$active_key_version" ||
  die 'APP_ENCRYPTION_ACTIVE_KEY_VERSION has an invalid version identifier'

decrypt_keys=$(optional_value_for APP_ENCRYPTION_DECRYPT_KEYS)
if [ -n "$decrypt_keys" ]; then
  case "$decrypt_keys" in
    ,* | *, | *,,*) die 'APP_ENCRYPTION_DECRYPT_KEYS has an empty entry' ;;
  esac

  # `set -f` because the unquoted split performs pathname expansion as well as
  # field splitting. A valid value contains no glob character, but a malformed
  # one can, and the refusal it earns would otherwise describe whatever files
  # happened to match in the deploy wrapper's working directory instead of the
  # value actually in runtime.env.
  previous_ifs=$IFS
  set -f
  IFS=,
  set -- $decrypt_keys
  IFS=$previous_ifs
  set +f
  [ "$#" -le 16 ] || die 'APP_ENCRYPTION_DECRYPT_KEYS has too many entries'

  seen_versions="|$active_key_version|"
  seen_keys="|$encryption_key|"
  entry_number=0
  for entry in "$@"; do
    entry_number=$((entry_number + 1))
    decrypt_version=${entry%%=*}
    decrypt_key=${entry#*=}
    [ "$decrypt_version" != "$entry" ] ||
      die "APP_ENCRYPTION_DECRYPT_KEYS entry $entry_number is malformed"
    valid_key_version "$decrypt_version" ||
      die "APP_ENCRYPTION_DECRYPT_KEYS entry $entry_number has an invalid version"
    validate_encryption_key "APP_ENCRYPTION_DECRYPT_KEYS entry $entry_number" "$decrypt_key"
    case "$seen_versions" in
      *"|$decrypt_version|"*)
        die "APP_ENCRYPTION_DECRYPT_KEYS entry $entry_number repeats a version"
        ;;
    esac
    case "$seen_keys" in
      *"|$decrypt_key|"*)
        die "APP_ENCRYPTION_DECRYPT_KEYS entry $entry_number reuses key material"
        ;;
    esac
    seen_versions="$seen_versions$decrypt_version|"
    seen_keys="$seen_keys$decrypt_key|"
  done
fi

# `docker-compose.yml` falls back to POSTGRES_PASSWORD=postgres when the value
# is absent, so a runtime file that merely forgets it does not fail any
# non-empty check — it silently deploys the database with a published default
# credential. The fallback exists for local development and has no business on a
# host that answers from the internet.
[ "$(value_for POSTGRES_PASSWORD)" != 'postgres' ] ||
  die 'POSTGRES_PASSWORD must not be the compose development fallback'

# DATABASE_URL and the POSTGRES_* trio describe the same database twice: compose
# creates it from the trio and the application reaches it through the URL. When
# they disagree the migration container connects successfully to the wrong
# database and applies a forward-only migration there. Compared by name only —
# the password in the URL is never extracted, split, or echoed.
database_url=$(value_for DATABASE_URL)
case "$database_url" in
  postgresql://*|postgres://*) ;;
  *) die 'DATABASE_URL must be a postgresql:// connection string' ;;
esac
url_rest=${database_url#*://}
case "$url_rest" in
  *@*) ;;
  *) die 'DATABASE_URL must carry the database role' ;;
esac
# Longest-match on `@` and shortest-match on `:` so a percent-encoded password
# containing either separator still splits at the right place.
url_userinfo=${url_rest%@*}
url_hostpath=${url_rest##*@}
case "$url_hostpath" in
  */*) ;;
  *) die 'DATABASE_URL must name a database' ;;
esac
url_database=${url_hostpath#*/}
url_database=${url_database%%\?*}
[ "$url_database" = "$(value_for POSTGRES_DB)" ] ||
  die 'DATABASE_URL names a different database than POSTGRES_DB'
[ "${url_userinfo%%:*}" = "$(value_for POSTGRES_USER)" ] ||
  die 'DATABASE_URL names a different role than POSTGRES_USER'

google_enabled=$(value_for GOOGLE_AUTH_ENABLED)
case "$google_enabled" in
  true)
    require_nonempty GOOGLE_CLIENT_ID
    require_nonempty GOOGLE_CLIENT_SECRET
    ;;
  false) ;;
  *) die 'GOOGLE_AUTH_ENABLED must be true or false' ;;
esac

mail_driver=$(value_for MAIL_DRIVER)
case "$mail_driver" in
  log) ;;
  resend) require_nonempty RESEND_API_KEY ;;
  ses) require_nonempty AWS_REGION ;;
  smtp)
    require_nonempty SMTP_HOST
    smtp_user=$(value_for SMTP_USER)
    smtp_password=$(value_for SMTP_PASSWORD)
    if [ -n "$smtp_user" ] || [ -n "$smtp_password" ]; then
      [ -n "$smtp_user" ] && [ -n "$smtp_password" ] || die 'SMTP_USER and SMTP_PASSWORD must be set together'
    fi
    ;;
  *) die 'MAIL_DRIVER is unsupported' ;;
esac

echo 'runtime preflight passed'
