#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

workflow=.github/workflows/publish-images.yml
grep -Fq 'workflow_run:' "$workflow"
grep -Fq "workflows: [CI]" "$workflow"
grep -Fq "branches: [main]" "$workflow"
grep -Fq "packages: write" "$workflow"
grep -Fq 'docker buildx bake --file docker-bake.hcl --push release' "$workflow"
grep -Fq 'image-digests-' "$workflow"
grep -Fq 'SOURCE_SHA: ${{ github.event.workflow_run.head_sha }}' "$workflow"
grep -Fq 'CI_RUN_ID: ${{ github.event.workflow_run.id }}' "$workflow"
grep -Fq 'publishRunId' "$workflow"
grep -Fq 'sourceWorkflow:"CI"' "$workflow"
grep -Fq 'docker buildx bake --file docker-bake.hcl release' .github/workflows/ci.yml

for target in backend backend-migration web platform; do
  grep -Fq "target \"$target\"" docker-bake.hcl
done

grep -Fq 'pnpm --filter app build' apps/app/Dockerfile
grep -Fq '/workspace/apps/app/.next/standalone' apps/app/Dockerfile
grep -Fq 'CMD ["node", "apps/app/server.js"]' apps/app/Dockerfile
grep -Fq 'ENV PORT=3001' apps/app/Dockerfile
grep -Fq 'EXPOSE 3001' apps/app/Dockerfile
grep -Fq 'ARG NEXT_PUBLIC_APP_NAME=Feedogo' apps/app/Dockerfile
grep -Fq 'NEXT_PUBLIC_APP_NAME = "Feedogo"' docker-bake.hcl

if grep -ERn ':latest([^A-Za-z]|$)' "$workflow" docker-bake.hcl; then
  echo 'latest is forbidden as a release identity' >&2
  exit 1
fi

echo 'image publishing invariants: ok'
