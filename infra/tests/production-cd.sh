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
grep -Fq 'deploy production $RELEASE_SHA $BACKEND_DIGEST $BACKEND_MIGRATION_DIGEST $WEB_DIGEST $PLATFORM_DIGEST' "$workflow"

# Four digests, and never the administrative one. The release carries an
# administrative image and the manifest reader exports its digest like any
# other, so this is the check that production does not deploy it: the surface
# is activated on staging only, and docs/security.md records production
# administrative exposure as an unsatisfied gate.
if grep -Fq 'ADMIN_DIGEST' "$workflow"; then
  echo 'production must not carry the administrative digest' >&2
  exit 1
fi
if grep -Eq '\$PLATFORM_DIGEST \$[A-Z_]+' "$workflow"; then
  echo 'production deploy must pass exactly the four required digests' >&2
  exit 1
fi
grep -Fq 'profiles: [staging]' infra/compose/compose.deploy.yaml || {
  echo 'the administrative service must be composed by the staging profile alone' >&2
  exit 1
}
grep -Fq 'rollback production' "$workflow"
grep -Fq 'PREVIOUS_RELEASE.json' infra/deploy/ai-agent-deploy
grep -Fq 'CURRENT_RELEASE.json' infra/deploy/ai-agent-deploy
grep -Fq 'component_digest "$previous_release" backend' infra/deploy/ai-agent-deploy
grep -Fq 'infra/tests/release-manifest.sh' .github/workflows/ci.yml

if grep -Eq 'headSha|head_sha|image-digests-' "$workflow"; then
  echo 'production evidence must come from the trusted staging manifest' >&2
  exit 1
fi

if grep -Fq 'docker build' "$workflow"; then
  echo 'production must not rebuild images' >&2
  exit 1
fi

echo 'production promotion invariants: ok'
