# Backup and restore

The production foundation combines Lightsail snapshots, daily logical
PostgreSQL dumps, local retention, and a prepared off-instance encrypted copy.
Each dump is custom format, non-empty, catalog-validated, atomically published,
and checksummed before the optional root-owned offsite hook runs.

Redis AOF is not a PostgreSQL backup. Snapshot existence and dump creation are
also not proof of recoverability. A restore drill must validate checksum and
archive, restore into an empty isolated database, start a compatible app, and
exercise identity, organization, and outbox paths.

The restore tool requires an explicit isolation token, a target database whose
actual server-reported name ends in `_restore_drill`, and a resolved server,
port, and database identity different from production. After checksum and
archive validation it also requires zero user relations, routines, types, and
non-public schemas before invoking `pg_restore`. It never drops or cleans a
target. Full procedure, retention, monitoring, and pending operator evidence are in
[`ops/backup-recovery.md`](../ops/backup-recovery.md).
