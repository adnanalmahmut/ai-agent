# Backup and recovery

PostgreSQL is the system of record. Redis AOF improves Redis restart behavior
but is not a database backup and cannot recover users, sessions, organizations,
or the transactional outbox.

## Layers

- Schedule daily Lightsail instance snapshots for production and define their
  retention in the operator account. Snapshots are a coarse host recovery
  layer, not a substitute for logical database restores.
- Install the systemd timer with `ops/backup/install-backups.sh`. It creates a
  custom-format `pg_dump` under a root-only directory, validates the archive
  catalog before atomically publishing it, writes SHA-256 metadata, and deletes
  local files older than `BACKUP_RETENTION_DAYS` (default 14).
- Prepare an off-instance destination in a separate failure domain. Install a
  reviewed root-owned `/usr/local/sbin/ai-agent-backup-offsite` hook that accepts
  exactly the dump and checksum paths and uploads them with encryption and
  destination-side retention. Cloud credentials stay in that tool's root-only
  configuration, never GitHub or runtime.env.

Monitor `systemctl status ai-agent-postgres-backup.timer`, journal failures,
backup age, local disk space, and offsite object presence. A file existing is
not proof it is restorable.

## Verification and restore drill

1. Run `ai-agent-verify-backup /var/backups/ai-agent/postgres/<file>.dump`.
2. Provision an empty, isolated PostgreSQL instance with no route to production.
3. Create a new empty database whose name ends in `_restore_drill`, set
   `RESTORE_DRILL_DATABASE_URL` in the operator's root shell, and run
   `ai-agent-restore-drill <dump> isolated-non-production`.
4. Start the application against the restored database in an isolated network;
   exercise sign-in, organization reads, and outbox/worker processing; record
   timestamp, source backup, duration, row-count checks, and result.
5. Destroy the isolated drill environment after retaining the drill record.

The tooling deliberately requires the literal confirmation token, the database
naming marker, a database identity different from live, and zero objects in
user schemas before restore. It never drops or cleans a database. Production disaster recovery
is an operator incident: isolate traffic, snapshot the failed state, provision
a replacement PostgreSQL target, restore the last verified dump, validate data,
install the compatible `CURRENT_SHA`, then reopen traffic. Do not overwrite the
only failed copy while investigating.

Live snapshot scheduling, offsite upload, alerting, and a successful restore
drill remain pending. Until the operator records a completed drill, this is an
implemented backup plan—not a claim of proven recovery.
