#!/bin/sh
set -eu

required_files='README.md
docs/architecture.md
docs/backend.md
docs/frontend.md
docs/authentication-rbac.md
docs/database.md
docs/redis-queue-outbox.md
docs/networking-real-ip.md
docs/rate-limiting.md
docs/geoip-session-location.md
docs/docker-compose.md
docs/lightsail.md
docs/nginx-tls.md
docs/ci.md
docs/cd.md
docs/deployment.md
docs/host-bundle.md
docs/rollback.md
docs/backup-restore.md
docs/security.md
docs/operations-runbook.md
docs/troubleshooting.md
docs/project-history.md'

for file in $required_files; do
  if [ ! -s "$file" ]; then
    echo "required documentation is missing or empty: $file" >&2
    exit 1
  fi
done

grep -Fq '```mermaid' docs/architecture.md
grep -Fq '```mermaid' docs/cd.md
grep -Fq 'VPS_SSH_PRIVATE_KEY' docs/deployment.md
grep -Fq 'root:root' docs/deployment.md
grep -Fq '0600' docs/deployment.md
grep -Fq 'PREVIOUS_RELEASE.json' docs/rollback.md
grep -Fq 'staging-success-<SHA>' docs/cd.md
grep -Fq 'explicit environment allowlist' docs/deployment.md
grep -Fq 'install-host-bundle.sh' docs/host-bundle.md
grep -Fq 'io.ai-agent.host-bundle.min-version' docs/host-bundle.md
grep -Fq 'host-bundle.manifest' docs/host-bundle.md
grep -Fq 'install-host-bundle.sh' docs/deployment.md
grep -Fq 'host bundle' docs/operations-runbook.md
grep -Fq '_restore_drill' docs/backup-restore.md
grep -Fiq 'restore drill' docs/backup-restore.md
if grep -Fq 'RUNTIME_ENV_FILE=' ops/environments/runtime.env.example; then
  echo 'runtime template must contain runtime settings, not its own path' >&2
  exit 1
fi

if grep -ERn --include='*.md' \
  'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20}' \
  README.md docs \
  apps/backend/README.md apps/platform/README.md apps/web/README.md; then
  echo 'documentation contains material that resembles a committed credential' >&2
  exit 1
fi

echo 'documentation checks passed'
