# Production promotion and rollback

> Production is not provisioned. This is a future operator runbook, not an
> executable current-state instruction. Coding agents must not dispatch the
> workflow, provision the environment, or operate a host.

Production is never deployed by a push. An operator dispatches `Promote
production` from `main`, chooses `promote`, and supplies an already-built
40-character source SHA. The workflow searches only successful `Deploy staging`
runs, downloads `staging-success-<sha>`, and validates its embedded run ID,
repository, workflow lineage and four image digests. It never treats a nested
workflow `headSha` as release evidence and never checks out or rebuilds source.

Configure the `production` GitHub Environment with required reviewers and
deployment-branch policy restricted to `main`. It uses the same variable and
secret names as staging but independent values and an independent key.

The host writes `CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json` only after
migration, service rollout, and internal health succeed. Each records the source
SHA and four OCI digests. A manual `rollback` action invokes the restricted
`rollback production` command, which redeploys the exact previous digests and
then runs internal and external health checks. It never resolves a tag. The
rollback path does not run the migration container or a down migration.

Database migrations are never rolled down automatically. Releases must follow
expand → migrate/backfill → switch → contract-later so both current and previous
application images remain compatible with the deployed schema. If that
compatibility is not true, application rollback is unsafe and the operator must
stop for incident-specific recovery.
