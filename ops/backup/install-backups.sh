#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
install -o root -g root -m 0755 ops/backup/backup-postgres.sh /usr/local/sbin/ai-agent-backup-postgres
install -o root -g root -m 0755 ops/backup/verify-backup.sh /usr/local/sbin/ai-agent-verify-backup
install -o root -g root -m 0755 ops/backup/restore-drill.sh /usr/local/sbin/ai-agent-restore-drill
install -o root -g root -m 0644 ops/backup/ai-agent-postgres-backup.service /etc/systemd/system/
install -o root -g root -m 0644 ops/backup/ai-agent-postgres-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-agent-postgres-backup.timer
