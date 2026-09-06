#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repo_root"

# One shared model plus one overlay per composition, and nothing else. A
# stray compose file anywhere in the tree is a second source of truth, which is
# what the split was supposed to remove rather than create.
base=infra/compose/compose.yaml
dev_overlay=infra/compose/compose.dev.yaml
test_overlay=infra/compose/compose.test.yaml
deploy_overlay=infra/compose/compose.deploy.yaml
all_compose="$base $dev_overlay $test_overlay $deploy_overlay"

compose_files=$(find . -path ./node_modules -prune -o \
  \( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' -o -name 'compose.*.y*ml' \) -print |
  sort | tr '\n' ' ')
test "$compose_files" = './infra/compose/compose.deploy.yaml ./infra/compose/compose.dev.yaml ./infra/compose/compose.test.yaml ./infra/compose/compose.yaml '

for port in 3000 3001 3002 5432 6379; do
  # shellcheck disable=SC2086
  if grep -En "^[[:space:]]*-[[:space:]]*['\"]?[^#]*:${port}:${port}" $all_compose \
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
    .github ops infra/compose >/dev/null; then
    echo "destructive volume command found: $forbidden" >&2
    exit 1
  fi
done

# The datastores and their volumes are shared, so they are asserted on the base
# file; the application services and the GeoIP volume exist only where a host
# runs them, so they are asserted on the deployment overlay. Asserting either
# against the wrong file would pass for as long as the other file happened to
# mention the string.
grep -Eq '^  data:$' "$base"
grep -Eq '^    internal: true$' "$base"
grep -Eq '^  postgres_data:$' "$base"
grep -Eq '^  redis_data:$' "$base"
grep -Eq '^  geoip_data:$' "$deploy_overlay"
grep -Eq 'command: \[node, dist/src/api/main\]' "$deploy_overlay"
grep -Eq 'command: \[node, dist/src/workers/main\]' "$deploy_overlay"
grep -Fq 'CMD ["node", "dist/src/api/main"]' apps/backend/Dockerfile
grep -Eq 'command: \[node, node_modules/prisma/build/index.js, migrate, deploy\]' "$deploy_overlay"
grep -Eq '^[[:space:]]+APP_PORT: 3002$' "$deploy_overlay"
# shellcheck disable=SC2086
if grep -Eq '^[[:space:]]+PORT: 3002$' $all_compose; then
  echo 'backend compose service must configure APP_PORT, not PORT' >&2
  exit 1
fi
backend_block=$(sed -n '/^  backend:/,/^  worker:/p' "$deploy_overlay")
if printf '%s\n' "$backend_block" | grep -Fq 'redis:'; then
  echo 'backend must not hard-depend on Redis health' >&2
  exit 1
fi
# shellcheck disable=SC2086
if grep -Fq 'env_file:' $all_compose; then
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
