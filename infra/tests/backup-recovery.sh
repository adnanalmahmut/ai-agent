#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

for script in infra/backup/backup-postgres.sh infra/backup/verify-backup.sh infra/backup/restore-drill.sh infra/backup/install-backups.sh; do
  sh -n "$script"
done
grep -Fq 'pg_dump --format=custom' infra/backup/backup-postgres.sh
grep -Fq 'pg_restore --list' infra/backup/backup-postgres.sh
grep -Fq 'sha256sum --check' infra/backup/restore-drill.sh
grep -Fq 'isolated-non-production' infra/backup/restore-drill.sh
grep -Fq '_restore_drill' infra/backup/restore-drill.sh
grep -Fq 'unsafe_object_count' infra/backup/restore-drill.sh
grep -Fq 'target resolves to the live runtime database' infra/backup/restore-drill.sh
grep -Fq 'infra/tests/restore-drill-safety.sh' .github/workflows/ci.yml
grep -Fq 'Persistent=true' infra/backup/ai-agent-postgres-backup.timer
grep -Fq 'BACKUP_RETENTION_DAYS=14' infra/backup/backup.conf.example

if grep -ER 'redis.*backup|Redis.*substitute' docs/runbooks/backup-recovery.md; then
  echo 'Redis must not be presented as PostgreSQL backup' >&2
  exit 1
fi
echo 'backup and restore invariants: ok'
