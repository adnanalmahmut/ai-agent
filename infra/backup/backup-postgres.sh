#!/bin/sh
set -eu
umask 077

environment_file=/etc/ai-agent/environment
config_file=/etc/ai-agent/backup.conf
compose_file=/opt/ai-agent/docker-compose.yml
compose_deploy_file=/opt/ai-agent/docker-compose.deploy.yml
[ "$(id -u)" -eq 0 ] || { echo 'run as root' >&2; exit 1; }
[ -r "$environment_file" ] && [ -r "$config_file" ] || exit 1

environment=$(sed -n '1p' "$environment_file")
[ "$environment" = staging ] || [ "$environment" = production ] || exit 64
. "$config_file"
: "${BACKUP_DIRECTORY:=/var/backups/ai-agent/postgres}"
: "${BACKUP_RETENTION_DAYS:=14}"
printf '%s' "$BACKUP_RETENTION_DAYS" | grep -Eq '^[1-9][0-9]{0,2}$' || exit 64

exec 9>/run/lock/ai-agent-postgres-backup.lock
flock -n 9 || { echo 'another backup is active' >&2; exit 1; }

install -d -o root -g root -m 0700 "$BACKUP_DIRECTORY"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$BACKUP_DIRECTORY/${environment}-${timestamp}.dump"
test ! -e "$final" || { echo 'backup timestamp collision' >&2; exit 1; }
temporary=$(mktemp --tmpdir="$BACKUP_DIRECTORY" .backup.XXXXXX)
trap 'rm -f "$temporary"' EXIT HUP INT TERM

docker compose --file "$compose_file" --file "$compose_deploy_file" \
  --profile "$environment" exec -T postgres \
  sh -c 'exec pg_dump --format=custom --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  >"$temporary"
test -s "$temporary"
docker compose --file "$compose_file" --file "$compose_deploy_file" \
  --profile "$environment" exec -T postgres \
  pg_restore --list <"$temporary" >/dev/null
mv "$temporary" "$final"
trap - EXIT HUP INT TERM
sha256sum "$final" >"$final.sha256"

if [ -x /usr/local/sbin/ai-agent-backup-offsite ]; then
  /usr/local/sbin/ai-agent-backup-offsite "$final" "$final.sha256"
fi

find "$BACKUP_DIRECTORY" -type f \( -name '*.dump' -o -name '*.dump.sha256' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete

echo "verified PostgreSQL backup created: $(basename "$final")"
