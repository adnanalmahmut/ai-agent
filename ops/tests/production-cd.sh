#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
workflow=.github/workflows/deploy-production.yml

grep -Fq 'workflow_dispatch:' "$workflow"
grep -Fq "github.ref == 'refs/heads/main'" "$workflow"
grep -Fq 'name: production' "$workflow"
grep -Fq 'group: deploy-production' "$workflow"
grep -Fq 'deploy-staging.yml' "$workflow"
grep -Fq 'staging-success-$RELEASE_SHA' "$workflow"
grep -Fq '.stagingRunId == $stagingRunId' "$workflow"
grep -Fq 'deploy production $RELEASE_SHA $BACKEND_DIGEST $MIGRATION_DIGEST $WEB_DIGEST $PLATFORM_DIGEST' "$workflow"
grep -Fq 'rollback production' "$workflow"
grep -Fq 'PREVIOUS_RELEASE.json' ops/lightsail/ai-agent-deploy
grep -Fq 'CURRENT_RELEASE.json' ops/lightsail/ai-agent-deploy
grep -Fq 'digest_from_manifest "$previous_release" backend' ops/lightsail/ai-agent-deploy

if grep -Eq 'headSha|head_sha|image-digests-' "$workflow"; then
  echo 'production evidence must come from the trusted staging manifest' >&2
  exit 1
fi

if grep -Fq 'docker build' "$workflow"; then
  echo 'production must not rebuild images' >&2
  exit 1
fi

echo 'production promotion invariants: ok'
