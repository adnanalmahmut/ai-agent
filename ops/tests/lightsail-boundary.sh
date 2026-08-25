#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

for script in \
  ops/lightsail/ai-agent-deploy \
  ops/lightsail/ai-agent-deploy-dispatch \
  ops/lightsail/bootstrap-host.sh \
  ops/lightsail/install-nginx.sh \
  ops/lightsail/issue-certificate.sh \
  ops/lightsail/reload-nginx-after-renewal; do
  sh -n "$script"
done

grep -Fq 'restrict,no-user-rc,command="/usr/local/sbin/ai-agent-deploy-dispatch"' ops/lightsail/bootstrap-host.sh
grep -Fq 'gpasswd -d deploy docker' ops/lightsail/bootstrap-host.sh
grep -Fq 'fallocate -l 2G /swapfile' ops/lightsail/bootstrap-host.sh
grep -Fq '/swapfile none swap sw 0 0' ops/lightsail/bootstrap-host.sh
grep -Fq 'vm.swappiness=10' ops/lightsail/bootstrap-host.sh
grep -Fq 'install_certbot_tls_asset options-ssl-nginx.conf /etc/letsencrypt/options-ssl-nginx.conf' ops/lightsail/issue-certificate.sh
grep -Fq 'install_certbot_tls_asset ssl-dhparams.pem /etc/letsencrypt/ssl-dhparams.pem' ops/lightsail/issue-certificate.sh
grep -Fq 'SHA must be 40 lowercase hex characters' ops/lightsail/ai-agent-deploy
grep -Fq 'digest must be 64 lowercase hex characters' ops/lightsail/ai-agent-deploy
grep -Fq 'runtime_env=/etc/ai-agent/runtime.env' ops/lightsail/ai-agent-deploy
grep -Fq 'ai-agent-runtime-preflight' ops/lightsail/ai-agent-deploy
grep -Fq 'BACKEND_MIGRATION_IMAGE="$registry/backend-migration@sha256:$migration_digest"' ops/lightsail/ai-agent-deploy
grep -Fq 'for service in platform web backend migrate; do' ops/lightsail/ai-agent-deploy
grep -Fq 'compose pull "$service"' ops/lightsail/ai-agent-deploy
if grep -Fq 'compose pull backend worker web platform migrate' ops/lightsail/ai-agent-deploy; then
  echo 'release images must not be pulled concurrently on small hosts' >&2
  exit 1
fi
grep -Fq 'compose up -d --wait postgres redis geoipupdate' ops/lightsail/ai-agent-deploy
grep -Fq 'running=$(compose ps --status running --services "$service")' ops/lightsail/ai-agent-deploy
grep -Fq '[ "$running" = "$service" ] || die "$service is not running"' ops/lightsail/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps backend' ops/lightsail/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps worker' ops/lightsail/ai-agent-deploy
grep -Fq 'compose up -d --wait --no-deps web platform' ops/lightsail/ai-agent-deploy
if grep -Fq 'compose ps --status running worker >/dev/null' ops/lightsail/ai-agent-deploy; then
  echo 'deployment must compare the returned running service name' >&2
  exit 1
fi
# The first-run bootstrap mints the platform's root credential, so it must
# require local host access rather than possession of the CI deploy key. The
# forced-command allowlist is what enforces that: if bootstrap-super-admin ever
# becomes remotely dispatchable, a compromised deployment secret becomes a
# platform takeover.
grep -Fq 'bootstrap-super-admin)' ops/lightsail/ai-agent-deploy
# Extracted from the shipped dispatch script rather than restated here, so
# widening the real allowlist fails this test instead of passing beside it.
dispatch_allowlist=$(sed -n "/grep -Eq/s/.*grep -Eq '\([^']*\)'.*/\1/p" ops/lightsail/ai-agent-deploy-dispatch)
[ -n "$dispatch_allowlist" ] || {
  echo 'could not read the forced-command allowlist from the dispatch script' >&2
  exit 1
}
for rejected in 'bootstrap-super-admin staging' 'bootstrap-super-admin production'; do
  if printf '%s\n' "$rejected" | grep -Eq "$dispatch_allowlist"; then
    echo 'super-admin bootstrap must not be reachable over the deploy key' >&2
    exit 1
  fi
done
# The allowlist must still admit what it is for, or the extraction silently
# matched nothing and the loop above proves nothing.
printf '%s\n' 'status staging' | grep -Eq "$dispatch_allowlist" || {
  echo 'extracted allowlist does not admit a known-good command' >&2
  exit 1
}

grep -Fq 'CURRENT_RELEASE.json' ops/lightsail/ai-agent-deploy
grep -Fq 'PREVIOUS_RELEASE.json' ops/lightsail/ai-agent-deploy
if grep -Eq 'ghcr\.io/.+:\$sha' ops/lightsail/ai-agent-deploy; then
  echo 'deployment must not resolve a mutable SHA tag' >&2
  exit 1
fi
grep -Fq 'storage: '\''database'\''' apps/backend/src/core/auth/auth.factory.ts

for forbidden in 'down'' -v' 'volume'' prune' 'system'' prune.*--volumes' 'eval .*SSH_ORIGINAL_COMMAND'; do
  if grep -ER "$forbidden" ops/lightsail >/dev/null; then
    echo 'destructive or evaluative deployment command found' >&2
    exit 1
  fi
done

echo 'Lightsail deployment boundary: ok'
