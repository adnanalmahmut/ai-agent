# Rollback

Every successful host rollout atomically rotates root-only
`CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json`. Each manifest contains the
40-character source SHA and the exact backend, migration, web, and platform OCI
digests. Manual production rollback invokes only `rollback production`; the
root wrapper validates the previous manifest, reconstructs image references
from fixed repository names, redeploys its exact application digests, and swaps
the manifests only after health succeeds.

Rollback does not execute migrations and never performs a down migration.
Database compatibility depends on expand → migrate/backfill → switch →
contract-later. If the previous app cannot run on the current schema, stop and
treat rollback as an incident-specific operation rather than forcing it.

After rollback, verify API readiness, worker process, `/`, `/platform/`, and
`/api/health/ready`; then inspect status and record the cause/timeline. A second
rollback swaps back to the release that was current immediately before it, so
operators must read metadata rather than assume direction. The migration image
digest is retained as release evidence but rollback never runs it.
