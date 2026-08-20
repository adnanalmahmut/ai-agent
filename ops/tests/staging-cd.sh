#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
workflow=.github/workflows/deploy-staging.yml

grep -Fq 'workflows: [Publish immutable images]' "$workflow"
grep -Fq 'environment:' "$workflow"
grep -Fq 'name: staging' "$workflow"
grep -Fq 'group: deploy-staging' "$workflow"
grep -Fq 'image-digests-' "$workflow"
grep -Fq 'run-id: ${{ github.event.workflow_run.id }}' "$workflow"
grep -Fq 'publishRunId == $publishRunId' "$workflow"
grep -Fq 'deploy staging $RELEASE_SHA $BACKEND_DIGEST $MIGRATION_DIGEST $WEB_DIGEST $PLATFORM_DIGEST' "$workflow"
grep -Fq 'ServerAliveInterval=30' "$workflow"
grep -Fq 'ServerAliveCountMax=20' "$workflow"
grep -Fq 'staging-success-${{ env.RELEASE_SHA }}' "$workflow"
grep -Fq 'stagingRunId' "$workflow"
grep -Fq 'health staging' "$workflow"
grep -Fq '/api/health/ready' "$workflow"

if grep -Fq 'github.event.workflow_run.head_sha' "$workflow"; then
  echo 'nested workflow_run head SHA must not be the release identity' >&2
  exit 1
fi

if grep -En '(^|[[:space:]])(env|set|printenv)([[:space:]]|$)|set -x' "$workflow"; then
  echo 'secret-dumping shell behavior found' >&2
  exit 1
fi

echo 'staging CD invariants: ok'
