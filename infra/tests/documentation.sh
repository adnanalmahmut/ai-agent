#!/bin/sh
set -eu

# The only test here that read its paths relative to the caller's directory
# rather than the repository's. It happened to work because CI runs it from the
# root; from anywhere else it reported that README.md was missing. Resolved the
# way every sibling resolves it, so moving this directory again cannot make the
# difference matter.
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

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
docs/release-retention.md
docs/rollback.md
docs/backup-restore.md
docs/security.md
docs/operations-runbook.md
docs/troubleshooting.md'

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
grep -Fq 'actions/upload-artifact@v7' docs/cd.md
grep -Fq 'actions/download-artifact@v8' docs/cd.md
grep -Fq 'infra/tests/artifact-contract.sh' docs/cd.md
grep -Fq 'CURRENT_RELEASE.json' docs/release-retention.md
grep -Fq 'PREVIOUS_RELEASE.json' docs/release-retention.md
grep -Fq 'docker image inspect' docs/release-retention.md
grep -Fq 'reclaim-locked' docs/release-retention.md
grep -Fq 'release-retention.md' docs/cd.md
grep -Fq 'release-retention.md' docs/rollback.md
grep -Fq 'ai-agent-release-retention' docs/host-bundle.md
grep -Fq 'explicit environment allowlist' docs/deployment.md
grep -Fq 'install-host-bundle.sh' docs/host-bundle.md
grep -Fq 'io.ai-agent.host-bundle.min-version' docs/host-bundle.md
grep -Fq 'host-bundle.manifest' docs/host-bundle.md
grep -Fq 'install-host-bundle.sh' docs/deployment.md
grep -Fq 'host bundle' docs/operations-runbook.md
grep -Fq '_restore_drill' docs/backup-restore.md
grep -Fiq 'restore drill' docs/backup-restore.md
# The administrative exposure gate has to stay documented, and has to stay
# documented as unmet. A future change that activates the surface has to move
# this line deliberately rather than let a stale "satisfied" ride along.
grep -Fq 'OP-3' docs/security.md
grep -Fq 'OP-3 is NOT SATISFIED' docs/security.md
grep -Fq 'OP-3' docs/deployment-state.md

# The staging ingress restriction is operator-configured, so the file it reads
# and the way it fails have to be written down where an operator will find
# them. A route nobody knows how to allow themselves through is indistinguishable
# from a broken deployment.
grep -Fq '/etc/ai-agent/admin-staging-allowed-cidrs' docs/security.md
grep -Fq '/etc/ai-agent/admin-staging-allowed-cidrs' docs/configuration.md
grep -Fq '/etc/ai-agent/admin-staging-allowed-cidrs' ops/staging-deployment.md
grep -Fq 'deny all' docs/security.md
grep -Fq 'install-nginx.sh' ops/staging-deployment.md
# And the boundary it is not: an allowlisted client is not an authorized one.
grep -Fiq 'ingress restriction is not an authorization' docs/security.md ||
  grep -Fiq 'An ingress restriction is not an authorization' docs/security.md

# Nothing may advertise a control this repository does not implement. The
# administrative surface is protected in production by not being deployed, and
# on staging by an address allowlist; saying more than that in documentation is
# how an unmet requirement gets forgotten.
if grep -rniE 'production[^.]{0,40}/admin|/admin[^.]{0,30}(is|are) (live|public)' \
  README.md docs ops; then
  echo 'documentation claims a production administrative surface' >&2
  exit 1
fi
if grep -rniE 'admin[^.]{0,40}(protected|secured) by (mfa|passkey|sso|vpn)|mfa (is )?enabled|passkeys? (are )?enabled|private admin network enabled' \
  README.md docs; then
  echo 'documentation claims a strong-authentication control that is not implemented' >&2
  exit 1
fi

if grep -Fq 'RUNTIME_ENV_FILE=' ops/environments/runtime.env.example; then
  echo 'runtime template must contain runtime settings, not its own path' >&2
  exit 1
fi

if grep -ERn --include='*.md' \
  'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20}' \
  README.md docs \
  apps/control-plane/README.md apps/app/README.md apps/web/README.md \
  apps/admin/README.md; then
  echo 'documentation contains material that resembles a committed credential' >&2
  exit 1
fi

echo 'documentation checks passed'
