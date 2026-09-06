# Rollback

Every successful host rollout atomically rotates root-only
`CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json`. Each manifest contains the
40-character source SHA and the exact OCI digest of every component, recorded
as `recordVersion: 1` with a component list. Records written before that format
existed are flat, with one field per image, and stay readable: a bundle update
must not cost a host the release it would roll back to. Both shapes are read
strictly — a record missing a component, or carrying anything but a `sha256`
digest, is refused rather than worked around. Manual production rollback invokes only `rollback production`; the
root wrapper validates the previous manifest, reconstructs image references
from fixed repository names, redeploys its exact application digests, and swaps
the manifests only after health succeeds.

Rollback runs the same gated path as a forward deployment, so it is refused by
the same host-bundle, runtime, image-label, compose-resolution, and extension
checks. A rollback target that a satisfied host once deployed still satisfies
it; a host whose bundle has since been hand-edited does not, and must be
reinstalled from the release checkout before rolling back.

Rollback also does not run release-image retention, and does not need to: the
images a rollback depends on are exactly the ones retention protects, because the
retained set is `CURRENT` plus `PREVIOUS` and `PREVIOUS` is what rollback reads.
Retention runs only on the forward-deployment path — adding an image mutation to
incident response would buy disk the next deployment's own preflight already
guards. See [release image retention](release-retention.md).

Rollback does not execute migrations and never performs a down migration.
Database compatibility depends on expand → migrate/backfill → switch →
contract-later. If the previous app cannot run on the current schema, stop and
treat rollback as an incident-specific operation rather than forcing it.

After rollback, verify API readiness, worker process, `/`, `/platform/`, and
`/api/health/ready`; then inspect status and record the cause/timeline. A second
rollback swaps back to the release that was current immediately before it, so
operators must read metadata rather than assume direction. The migration image
digest is retained as release evidence but rollback never runs it.
