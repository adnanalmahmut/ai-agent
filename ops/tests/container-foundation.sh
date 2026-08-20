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

echo 'container foundation invariants: ok'
