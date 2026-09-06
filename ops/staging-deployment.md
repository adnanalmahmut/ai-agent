# Staging deployment

`deploy-staging.yml` starts only after the immutable-image publisher succeeds
for `main`. It downloads the artifact from the exact triggering Publish run ID
and derives the source SHA and every component digest from that validated
manifest, through the shared reader that accepts both manifest versions;
the nested workflow's own Git head is never release identity. It neither checks
out nor rebuilds application source.

The `staging` GitHub Environment supplies public variables `VPS_HOST`,
`VPS_USER`, `VPS_SSH_KNOWN_HOSTS`, and `DEPLOYMENT_URL`, plus only the restricted
`VPS_SSH_PRIVATE_KEY` secret. The job never receives database, auth, mail,
OAuth, Redis, or MaxMind credentials.

The forced SSH command invokes `deploy staging <sha> <four digest hex values>`
and carries nothing else: the release's host requirement travels on its own
image labels, so the forced-command grammar stays exactly as wide as it is.

Repository names are fixed on the host. The root wrapper holds a host lock,
verifies the recorded host bundle and free space, validates the runtime file,
pulls digest references, checks the pulled images' release and host-bundle
labels and the compose file's resolved images, starts data services, confirms
the database provides the extensions the release's migrations need, then runs
the digest-pinned migration image and stops immediately if migration fails.
Every one of those refusals happens before the migration container starts. Only then does it update
API/readiness, worker/process status, web, and platform. GitHub exercises all
three public HTTPS routes and uploads `staging-success-<sha>` containing the
same digests and its own workflow-run identity.

Staging is provisioned and is changed only by the automatic post-`main` CD
path. Repository agents must not deploy manually, connect to the VPS, edit the
root-owned runtime file, or modify GitHub Environment values. Live host and
credential evidence remains operator-owned and must not be copied into Git.
