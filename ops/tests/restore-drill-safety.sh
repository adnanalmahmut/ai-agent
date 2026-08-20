#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
mkdir -p "$tmp_dir/bin" "$tmp_dir/etc/ai-agent"
dump=$tmp_dir/backup.dump
touch "$dump" "$dump.sha256"
printf 'DATABASE_URL=postgresql://live@database/production\n' >"$tmp_dir/etc/ai-agent/runtime.env"

sed "s#/etc/ai-agent#$tmp_dir/etc/ai-agent#g" \
  ops/backup/restore-drill.sh >"$tmp_dir/restore-drill"
chmod +x "$tmp_dir/restore-drill"

cat >"$tmp_dir/bin/id" <<'SH'
#!/bin/sh
printf '0\n'
SH
cat >"$tmp_dir/bin/sha256sum" <<'SH'
#!/bin/sh
echo CHECKSUM >>"$RESTORE_TEST_LOG"
exit 0
SH
cat >"$tmp_dir/bin/pg_restore" <<'SH'
#!/bin/sh
case " $* " in
  *' --list '*) echo ARCHIVE_LIST >>"$RESTORE_TEST_LOG" ;;
  *) echo RESTORE >>"$RESTORE_TEST_LOG" ;;
esac
exit 0
SH
cat >"$tmp_dir/bin/psql" <<'SH'
#!/bin/sh
url=$1
case "$*" in
  *'select current_database()'*)
    printf '%s\n' "${MOCK_TARGET_DATABASE:-empty_restore_drill}"
    ;;
  *'target_identity'*)
    case "$url" in
      *'/production') printf '%s\n' '10.0.0.10:5432/production' ;;
      *) printf '%s\n' "${MOCK_TARGET_IDENTITY:-10.0.0.20:5432/empty_restore_drill}" ;;
    esac
    ;;
  *'unsafe_object_count'*)
    printf '%s\n' "${MOCK_UNSAFE_OBJECT_COUNT:-0}"
    ;;
  *"information_schema.tables"*)
    printf '12\n'
    ;;
  *) exit 1 ;;
esac
SH
chmod +x "$tmp_dir/bin/id" "$tmp_dir/bin/sha256sum" "$tmp_dir/bin/pg_restore" "$tmp_dir/bin/psql"

export PATH="$tmp_dir/bin:$PATH"
export RESTORE_TEST_LOG=$tmp_dir/restore.log
export RESTORE_DRILL_DATABASE_URL=postgresql://drill@isolated/empty_restore_drill

: >"$RESTORE_TEST_LOG"
"$tmp_dir/restore-drill" "$dump" isolated-non-production >/dev/null
test "$(sed -n '1p' "$RESTORE_TEST_LOG")" = CHECKSUM
test "$(sed -n '2p' "$RESTORE_TEST_LOG")" = ARCHIVE_LIST
test "$(grep -c '^RESTORE$' "$RESTORE_TEST_LOG")" -eq 1

: >"$RESTORE_TEST_LOG"
if MOCK_UNSAFE_OBJECT_COUNT=1 "$tmp_dir/restore-drill" "$dump" isolated-non-production >/dev/null 2>&1; then
  echo 'restore drill accepted a non-empty target' >&2
  exit 1
fi
if grep -Fq RESTORE "$RESTORE_TEST_LOG"; then
  echo 'restore started before rejecting non-empty target' >&2
  exit 1
fi

: >"$RESTORE_TEST_LOG"
if MOCK_TARGET_IDENTITY=10.0.0.10:5432/production \
  "$tmp_dir/restore-drill" "$dump" isolated-non-production >/dev/null 2>&1; then
  echo 'restore drill accepted the live database identity' >&2
  exit 1
fi
if grep -Fq RESTORE "$RESTORE_TEST_LOG"; then
  echo 'restore started against a live-equivalent target' >&2
  exit 1
fi

: >"$RESTORE_TEST_LOG"
if MOCK_TARGET_DATABASE=production \
  "$tmp_dir/restore-drill" "$dump" isolated-non-production >/dev/null 2>&1; then
  echo 'restore drill accepted a target without the naming isolation marker' >&2
  exit 1
fi

echo 'restore drill safety invariants: ok'
