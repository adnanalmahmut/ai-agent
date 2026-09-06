#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 1
# Resolved from this script's location, so the units and executables it
# installs are the ones that shipped beside it rather than whatever the
# operator's working directory happens to contain.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -o root -g root -m 0755 "$here/backup-postgres.sh" /usr/local/sbin/ai-agent-backup-postgres
install -o root -g root -m 0755 "$here/verify-backup.sh" /usr/local/sbin/ai-agent-verify-backup
install -o root -g root -m 0755 "$here/restore-drill.sh" /usr/local/sbin/ai-agent-restore-drill
install -o root -g root -m 0644 "$here/ai-agent-postgres-backup.service" /etc/systemd/system/
install -o root -g root -m 0644 "$here/ai-agent-postgres-backup.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ai-agent-postgres-backup.timer
