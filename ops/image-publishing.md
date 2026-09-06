# Image publishing

The verify-only PR workflow receives no deployment credentials. After the CI
workflow succeeds on `main`, `publish-images.yml` checks out that exact head SHA
and invokes one Buildx Bake release group. It publishes the components listed
in `infra/release/components` — backend API/worker, backend-migration, web, and
platform — under the 40-character commit tag. That catalog is the one place the
component set is stated; `infra/tests/artifact-contract.sh` holds the bake
group, the manifest reader, the deploy wrapper, and release retention to it.

No `latest` deployment identity exists. BuildKit provenance and SBOM
attestations are enabled. The workflow resolves every pushed manifest digest
and uploads one `image-digests-<sha>` JSON artifact, a `schemaVersion: 3`
component manifest. Staging and production CD
consume that record; production never rebuilds source.

GHCR publication uses the job-scoped `GITHUB_TOKEN` with `packages: write`.
No VPS credential or application runtime secret is available to this workflow.
