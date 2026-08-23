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

required='NODE_ENV
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
DATABASE_URL
REDIS_URL
APP_ENCRYPTION_KEY
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
encryption_key=$(value_for APP_ENCRYPTION_KEY)
case "$encryption_key" in
  *[!A-Za-z0-9+/=]* | *=[!=]*) die 'APP_ENCRYPTION_KEY must be base64' ;;
esac
encryption_key_bytes=$(printf '%s' "$encryption_key" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]') ||
  die 'APP_ENCRYPTION_KEY must be base64'
[ "$encryption_key_bytes" = '32' ] ||
  die 'APP_ENCRYPTION_KEY must decode to 32 bytes (generate with: openssl rand -base64 32)'

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
