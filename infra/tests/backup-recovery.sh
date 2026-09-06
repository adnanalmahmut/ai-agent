#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

for script in ops/backup/backup-postgres.sh ops/backup/verify-backup.sh ops/backup/restore-drill.sh ops/backup/install-backups.sh; do
  sh -n "$script"
done
grep -Fq 'pg_dump --format=custom' ops/backup/backup-postgres.sh
grep -Fq 'pg_restore --list' ops/backup/backup-postgres.sh
grep -Fq 'sha256sum --check' ops/backup/restore-drill.sh
grep -Fq 'isolated-non-production' ops/backup/restore-drill.sh
grep -Fq '_restore_drill' ops/backup/restore-drill.sh
grep -Fq 'unsafe_object_count' ops/backup/restore-drill.sh
grep -Fq 'target resolves to the live runtime database' ops/backup/restore-drill.sh
grep -Fq 'infra/tests/restore-drill-safety.sh' .github/workflows/ci.yml
grep -Fq 'Persistent=true' ops/backup/ai-agent-postgres-backup.timer
grep -Fq 'BACKUP_RETENTION_DAYS=14' ops/backup/backup.conf.example

if grep -ER 'redis.*backup|Redis.*substitute' ops/backup-recovery.md; then
  echo 'Redis must not be presented as PostgreSQL backup' >&2
  exit 1
fi
echo 'backup and restore invariants: ok'
