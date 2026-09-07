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

for target in backend backend-migration web platform admin; do
  grep -Fq "target \"$target\"" docker-bake.hcl
done

grep -Fq 'pnpm --filter app build' apps/app/Dockerfile
grep -Fq '/workspace/apps/app/.next/standalone' apps/app/Dockerfile
grep -Fq 'CMD ["node", "apps/app/server.js"]' apps/app/Dockerfile
grep -Fq 'ENV PORT=3001' apps/app/Dockerfile
grep -Fq 'EXPOSE 3001' apps/app/Dockerfile
grep -Fq 'ARG NEXT_PUBLIC_APP_NAME=Feedogo' apps/app/Dockerfile
grep -Fq 'NEXT_PUBLIC_APP_NAME = "Feedogo"' docker-bake.hcl

# The administrative surface is published with every release and is optional in
# the catalog: it has a bake target, a repository and a component name of its
# own, it is in the release group -- which `infra/tests/artifact-contract.sh`
# holds equal to the component catalog -- and no deployment is required to run
# it. A host must never build it from source, which is what publishing it here
# is for.
grep -Fq 'target "admin"' docker-bake.hcl
grep -Fq '"io.ai-agent.component.name" = "admin"' docker-bake.hcl
grep -Fq '${REGISTRY}/admin:${IMAGE_TAG}' docker-bake.hcl
sed -n '/^group "release"/,/}/p' docker-bake.hcl | grep -Fq 'admin' || {
  echo 'the admin image must be published with the release set' >&2
  exit 1
}
grep -Fq 'admin admin false' infra/release/components || {
  echo 'the admin component must be optional in the release catalog' >&2
  exit 1
}
# A deployment that does not run it is not missing anything, and nothing may
# quietly make it a required artifact.
if grep -Eq '^admin admin true' infra/release/components; then
  echo 'the admin component must not be required' >&2
  exit 1
fi
grep -Fq 'pnpm --filter admin build' apps/admin/Dockerfile
grep -Fq '/workspace/apps/admin/.next/standalone' apps/admin/Dockerfile
grep -Fq 'CMD ["node", "apps/admin/server.js"]' apps/admin/Dockerfile
grep -Fq 'ENV PORT=3003' apps/admin/Dockerfile
grep -Fq 'EXPOSE 3003' apps/admin/Dockerfile

if grep -ERn ':latest([^A-Za-z]|$)' "$workflow" docker-bake.hcl; then
  echo 'latest is forbidden as a release identity' >&2
  exit 1
fi

echo 'image publishing invariants: ok'
