#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

compose_files=$(find . -name docker-compose.yml -o -name docker-compose.yaml)
test "$compose_files" = './docker-compose.yml'

for port in 3000 3001 3002 5432 6379; do
  if grep -En "^[[:space:]]*-[[:space:]]*['\"]?[^#]*:${port}:${port}" docker-compose.yml \
    | grep -Ev '127\.0\.0\.1:' >/dev/null; then
    echo "port ${port} has a non-loopback host binding" >&2
    exit 1
  fi
done

for forbidden in 'down'' -v' 'volume'' prune' 'system'' prune --volumes'; do
  if grep -ERn "$forbidden" \
    --include '*.sh' \
    --include '*.yml' \
    --include '*.yaml' \
    --exclude container-foundation.sh \
    .github ops docker-compose.yml >/dev/null; then
    echo "destructive volume command found: $forbidden" >&2
    exit 1
  fi
done

grep -Eq '^  data:$' docker-compose.yml
grep -Eq '^    internal: true$' docker-compose.yml
grep -Eq '^  postgres_data:$' docker-compose.yml
grep -Eq '^  redis_data:$' docker-compose.yml
grep -Eq '^  geoip_data:$' docker-compose.yml
grep -Eq 'command: \[node, dist/src/main\]' docker-compose.yml
grep -Eq 'command: \[node, dist/src/worker\]' docker-compose.yml
grep -Eq 'command: \[node, node_modules/prisma/build/index.js, migrate, deploy\]' docker-compose.yml
grep -Eq '^[[:space:]]+APP_PORT: 3002$' docker-compose.yml
if grep -Eq '^[[:space:]]+PORT: 3002$' docker-compose.yml; then
  echo 'backend compose service must configure APP_PORT, not PORT' >&2
  exit 1
fi
backend_block=$(sed -n '/^  backend:/,/^  worker:/p' docker-compose.yml)
if printf '%s\n' "$backend_block" | grep -Fq 'redis:'; then
  echo 'backend must not hard-depend on Redis health' >&2
  exit 1
fi
if grep -Fq 'env_file:' docker-compose.yml; then
  echo 'containers must receive explicit environment allowlists' >&2
  exit 1
fi

for dockerfile in \
  apps/backend/Dockerfile \
  apps/web/Dockerfile \
  apps/platform/Dockerfile; do
  test -f "$dockerfile"
  if grep -En '^(ENV|ARG).*(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=' "$dockerfile"; then
    echo "credential-like build argument found in $dockerfile" >&2
    exit 1
  fi
done

grep -Fq 'COPY packages/i18n-core packages/i18n-core' apps/backend/Dockerfile
grep -Fq 'COPY packages/i18n-core packages/i18n-core' apps/web/Dockerfile
grep -Fq 'COPY packages/ui packages/ui' apps/web/Dockerfile
grep -Fq 'COPY packages/i18n-core packages/i18n-core' apps/platform/Dockerfile
grep -Fq 'COPY packages/ui packages/ui' apps/platform/Dockerfile
grep -Fq 'CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]' apps/backend/Dockerfile
if grep -Fq 'CMD ["pnpm",' apps/backend/Dockerfile; then
  echo 'migration runtime must not depend on a mutable Corepack cache' >&2
  exit 1
fi

echo 'container foundation invariants: ok'
