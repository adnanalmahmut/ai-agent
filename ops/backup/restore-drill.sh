#!/bin/sh
set -eu

die() {
  echo "restore drill rejected: $*" >&2
  exit 64
}

[ "$(id -u)" -eq 0 ] || die 'run as root'
[ "$#" -eq 2 ] || die 'usage: restore-drill.sh <dump-file> isolated-non-production'
[ "$2" = isolated-non-production ] || die 'explicit isolation marker is required'
: "${RESTORE_DRILL_DATABASE_URL:?set only to an empty isolated PostgreSQL database}"
printf '%s' "$RESTORE_DRILL_DATABASE_URL" | grep -Eq '^postgres(ql)?://' || die 'target must be a PostgreSQL URL'

dump=$1
[ -f "$dump" ] && [ -f "$dump.sha256" ] || die 'dump or checksum is missing'

# Verify the evidence before making any target connection or write.
(cd "$(dirname "$dump")" && sha256sum --check "$(basename "$dump").sha256")
pg_restore --list "$dump" >/dev/null

# Resolve database identity through PostgreSQL rather than comparing URL text;
# aliases and different encodings can point at the same live target.
target_database=$(psql "$RESTORE_DRILL_DATABASE_URL" -XAtc 'select current_database()')
printf '%s' "$target_database" | grep -Eq '^[a-z0-9_]+_restore_drill$' || \
  die 'target database name must end with _restore_drill'

identity_sql="select concat(coalesce(inet_server_addr()::text,'local'), ':', inet_server_port(), '/', current_database()) as target_identity"
target_identity=$(psql "$RESTORE_DRILL_DATABASE_URL" -XAtc "$identity_sql")
[ -n "$target_identity" ] || die 'could not resolve target database identity'

runtime_database_url=$(sed -n 's/^DATABASE_URL=//p' /etc/ai-agent/runtime.env 2>/dev/null || true)
if [ -n "$runtime_database_url" ]; then
  live_identity=$(psql "$runtime_database_url" -XAtc "$identity_sql") || \
    die 'could not resolve live database identity'
  [ "$target_identity" != "$live_identity" ] || die 'target resolves to the live runtime database'
fi

# Reject every relation, routine, user-defined type, or non-public user schema
# before pg_restore. A fresh database's public schema is allowed; its contents
# are not. This is intentionally stricter than counting application tables.
unsafe_object_count=$(psql "$RESTORE_DRILL_DATABASE_URL" -XAtc "
  with unsafe_objects as (
    select c.oid from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    union all
    select p.oid from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
    union all
    select t.oid from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
        and t.typtype in ('c', 'd', 'e', 'r')
    union all
    select n.oid from pg_namespace n
      where n.nspname <> 'public' and n.nspname <> 'information_schema'
        and n.nspname !~ '^pg_'
  )
  select count(*) as unsafe_object_count from unsafe_objects;")
printf '%s' "$unsafe_object_count" | grep -Eq '^[0-9]+$' || die 'could not verify target emptiness'
[ "$unsafe_object_count" -eq 0 ] || die 'target database is not empty'

pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname "$RESTORE_DRILL_DATABASE_URL" "$dump"

table_count=$(psql "$RESTORE_DRILL_DATABASE_URL" -XAtc \
  "select count(*) from information_schema.tables where table_schema = 'public';")
[ "$table_count" -gt 0 ]
echo "restore drill completed with $table_count public tables"
