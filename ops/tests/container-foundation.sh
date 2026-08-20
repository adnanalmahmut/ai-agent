#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

compose_files=$(find . -name docker-compose.yml -o -name docker-compose.yaml)
test "$compose_files" = './docker-compose.yml'

for port in 3000 3001 3002 5432 6379; do
  if rg -n "^[[:space:]]*-[[:space:]]*['\"]?[^#]*:${port}:${port}" docker-compose.yml \
    | rg -v '127\.0\.0\.1:' >/dev/null; then
    echo "port ${port} has a non-loopback host binding" >&2
    exit 1
  fi
done

for forbidden in 'down'' -v' 'volume'' prune' 'system'' prune --volumes'; do
  if rg -n "$forbidden" \
    --glob '*.sh' \
    --glob '*.yml' \
    --glob '*.yaml' \
    --glob '!ops/tests/container-foundation.sh' \
    . >/dev/null; then
    echo "destructive volume command found: $forbidden" >&2
    exit 1
  fi
done

rg -q '^  data:$' docker-compose.yml
rg -q '^    internal: true$' docker-compose.yml
rg -q '^  postgres_data:$' docker-compose.yml
rg -q '^  redis_data:$' docker-compose.yml
rg -q '^  geoip_data:$' docker-compose.yml
rg -q 'command: \[node, dist/src/main\]' docker-compose.yml
rg -q 'command: \[node, dist/src/worker\]' docker-compose.yml

for dockerfile in \
  apps/backend/Dockerfile \
  apps/web/Dockerfile \
  apps/platform/Dockerfile; do
  test -f "$dockerfile"
  if rg -n '^(ENV|ARG).*(PASSWORD|SECRET|TOKEN|PRIVATE_KEY)=' "$dockerfile"; then
    echo "credential-like build argument found in $dockerfile" >&2
    exit 1
  fi
done

echo 'container foundation invariants: ok'
