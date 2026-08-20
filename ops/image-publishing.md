# Image publishing

The verify-only PR workflow receives no deployment credentials. After the CI
workflow succeeds on `main`, `publish-images.yml` checks out that exact head SHA
and invokes one Buildx Bake release group. It publishes backend API/worker,
migration, web, and platform images under the 40-character commit tag.

No `latest` deployment identity exists. BuildKit provenance and SBOM
attestations are enabled. The workflow resolves every pushed manifest digest
and uploads one `image-digests-<sha>` JSON artifact. Staging and production CD
consume that record; production never rebuilds source.

GHCR publication uses the job-scoped `GITHUB_TOKEN` with `packages: write`.
No VPS credential or application runtime secret is available to this workflow.
