# Staging deployment

`deploy-staging.yml` starts only after the immutable-image publisher succeeds
for `main`. It downloads the artifact from the exact triggering Publish run ID
and derives the source SHA and all four digests from that validated manifest;
the nested workflow's own Git head is never release identity. It neither checks
out nor rebuilds application source.

The `staging` GitHub Environment supplies public variables `VPS_HOST`,
`VPS_USER`, `VPS_SSH_KNOWN_HOSTS`, and `DEPLOYMENT_URL`, plus only the restricted
`VPS_SSH_PRIVATE_KEY` secret. The job never receives database, auth, mail,
OAuth, Redis, or MaxMind credentials.

The forced SSH command invokes `deploy staging <sha> <four digest hex values>`.
Repository names are fixed on the host. The root wrapper holds a host lock,
pulls digest references, starts data services, runs the digest-pinned migration
image, and stops immediately if migration fails. Only then does it update
API/readiness, worker/process status, web, and platform. GitHub exercises all
three public HTTPS routes and uploads `staging-success-<sha>` containing the
same digests and its own workflow-run identity.

Staging is provisioned and is changed only by the automatic post-`main` CD
path. Repository agents must not deploy manually, connect to the VPS, edit the
root-owned runtime file, or modify GitHub Environment values. Live host and
credential evidence remains operator-owned and must not be copied into Git.
