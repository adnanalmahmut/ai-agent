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
grep -Fq 'deploy staging $RELEASE_SHA' "$workflow"
grep -Fq 'health staging' "$workflow"
grep -Fq '/api/health/ready' "$workflow"

if grep -En '(^|[[:space:]])(env|set|printenv)([[:space:]]|$)|set -x' "$workflow"; then
  echo 'secret-dumping shell behavior found' >&2
  exit 1
fi

echo 'staging CD invariants: ok'
