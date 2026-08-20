#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
[ "$#" -eq 1 ] || { echo 'usage: verify-backup.sh <dump-file>' >&2; exit 64; }
dump=$1
case "$dump" in /var/backups/ai-agent/postgres/*.dump) ;; *) exit 64 ;; esac
test -f "$dump" && test -f "$dump.sha256"
(cd "$(dirname "$dump")" && sha256sum --check "$(basename "$dump").sha256")
environment=$(sed -n '1p' /etc/ai-agent/environment)
docker compose --file /opt/ai-agent/docker-compose.yml --profile "$environment" exec -T postgres \
  pg_restore --list <"$dump" >/dev/null
echo 'backup checksum and archive catalog: ok'
