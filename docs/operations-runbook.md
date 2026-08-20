# Operations runbook

## Routine checks

1. `systemctl status nginx docker ai-agent-postgres-backup.timer`.
2. Run restricted `status <environment>` and `health <environment>`.
3. Check public `/`, `/platform/`, and `/api/health/ready` over HTTPS.
4. Check certificate expiry/renewal, disk and volume capacity, backup age,
   offsite presence, PostgreSQL health, Redis AOF, worker status, and outbox age.
5. Review structured warnings for Redis fail-open, GeoIP unavailability, mail,
   queue retries, and rate limits without dumping environment data.

## Release

Merge only after stacked PR review. Main CI publishes once; staging deploys
automatically from the exact publisher-run manifest. Verify staging behavior
and its `staging-success-<SHA>` evidence. Dispatch production from `main` with
that staged SHA, approve its Environment, and retain the deployment record.
Never run migrations manually after a failed migration gate without
understanding the database state.

## Incident priorities

- Nginx/TLS failure: keep containers private, validate config/certificate/DNS,
  then reload; do not expose upstream ports as a workaround.
- Redis failure: API ordinary routes fail open for limits and accepted async
  work accumulates durably; recover Redis/worker and monitor outbox drainage.
- PostgreSQL failure: stop writes/traffic, preserve failed state, use the last
  verified restore evidence, and follow the recovery runbook.
- Bad release: use application rollback only when schema remains compatible.
- Suspected credential exposure: revoke at the owning boundary, replace the VPS
  runtime file/key, and redeploy; do not paste evidence containing secret values.
