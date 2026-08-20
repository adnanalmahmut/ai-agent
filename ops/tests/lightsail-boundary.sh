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
grep -Fq 'SHA must be 40 lowercase hex characters' ops/lightsail/ai-agent-deploy
grep -Fq 'runtime_env=/etc/ai-agent/runtime.env' ops/lightsail/ai-agent-deploy
grep -Fq 'storage: '\''database'\''' apps/backend/src/core/auth/auth.factory.ts

if grep -ER 'docker compose down -v|docker volume prune|docker system prune.*--volumes|eval .*SSH_ORIGINAL_COMMAND' ops/lightsail; then
  echo 'destructive or evaluative deployment command found' >&2
  exit 1
fi

echo 'Lightsail deployment boundary: ok'
