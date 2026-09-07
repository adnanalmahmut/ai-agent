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
# Five digests. The fifth is the administrative surface, which staging is the
# only environment to deploy -- and it is validated before it is sent, so a
# manifest that somehow carried no administrative component fails here rather
# than being concatenated into a command the host would reject.
grep -Fq 'deploy staging $RELEASE_SHA $BACKEND_DIGEST $BACKEND_MIGRATION_DIGEST $WEB_DIGEST $PLATFORM_DIGEST $ADMIN_DIGEST' "$workflow"
grep -Fq "printf '%s\\n' \"\$ADMIN_DIGEST\" | grep -Eq '^[0-9a-f]{64}\$'" "$workflow" || {
  echo 'the administrative digest must be validated before it is sent' >&2
  exit 1
}

# And the surface must not be publicly served. The runner is not an allowlisted
# client, so a success from it would mean the ingress restriction is not there.
grep -Fq '/admin/health' "$workflow" || {
  echo 'staging CD no longer checks that the administrative surface is closed' >&2
  exit 1
}
grep -Fq 'the administrative surface answered an unallowlisted client' "$workflow"
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
