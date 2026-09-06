# Operations runbook

Staging is the only provisioned environment. Use the installed wrappers; do not
run Compose directly against the live host or read
`/etc/ai-agent/runtime.env`.

## Routine checks

1. Check `nginx`, `docker`, and `ai-agent-postgres-backup.timer`.
2. Run `sudo ai-agent-deploy status staging` and
   `sudo ai-agent-deploy health staging`.
3. Check public `/`, `/platform/`, and `/api/health/ready` over HTTPS.
4. Review certificate expiry, disk and volume capacity, backup age/offsite
   presence, PostgreSQL, Redis AOF, worker health, and outbox age.
5. Review structured warnings without dumping environment values.

## First super administrator

On a newly provisioned host:

```sh
sudo ai-agent-deploy bootstrap-super-admin staging \
  --email <address> --name '<display name>'
```

The wrapper selects the backend image from `CURRENT_RELEASE.json`, allocates a
terminal for the hidden password prompt, and keeps this operation outside the
CI deploy key's forced-command grammar. Do not pass the password as an argument
or environment value.

For local development:

```sh
pnpm --filter control-plane cli:dev super-admin:create \
  --email <address> --name '<display name>'
```

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| 0    | Created                                 |
| 1    | Invalid arguments or password input     |
| 2    | A super administrator already exists    |
| 3    | Another bootstrap holds the lock        |
| 4    | The email already belongs to an account |
| 5    | Creation or cleanup failed              |

On exit 5, inspect whether a role-bearing user without a credential account was
left behind before retrying. The command normally removes that partial row. The
bootstrap gate counts banned and deactivated super administrators; account
recovery is not a reason to reopen first-run bootstrap.

## Managed-secret key rotation

Changing `APP_ENCRYPTION_KEY` does not re-encrypt existing rows. Keep the old
key as a decrypt-only entry until rotation and backup-retention requirements are
complete.

1. Confirm the installed host bundle provides the rotation command and no
   deployment is active.
2. Configure the new key as active and keep the previous
   `version=base64-key` in `APP_ENCRYPTION_DECRYPT_KEYS`.
3. Deploy so new writes use the new key.
4. Run the live rotation.
5. Run a dry check; it must examine rows and report every row current.
6. Keep the old key until no retained database backup could restore rows sealed
   by it. Then remove it and deploy again.

Use the host wrapper, never a local checkout pointed at a live database:

```sh
sudo ai-agent-deploy rotate-managed-secret-keys staging --dry-run
sudo ai-agent-deploy rotate-managed-secret-keys staging
sudo ai-agent-deploy rotate-managed-secret-keys staging --dry-run
```

The command holds the deployment lock. It is resumable: rows already on the
active key are skipped, and rows changed concurrently are retried on a later
run.

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| 0    | All examined secrets use the active version                   |
| 1    | Invalid arguments                                             |
| 2    | The table is not fully current, or a dry run examined no rows |
| 3    | Rotation did not finish                                       |
| 5    | Process failure outside the command                           |
| 64   | Host wrapper refusal, including lock or bundle mismatch       |

On exit 2, resolve every reported row before retiring a key: restore a missing
decrypt key or re-enter an unreadable credential; rerun rows changed during the
sweep; deploy a build that recognizes an unknown registered slot or remove that
slot through the Platform after verifying it is obsolete.

## Host bundle updates

From a checkout of the release to install, with no deployment active:

```sh
sudo infra/deploy/install-host-bundle.sh
sudo ai-agent-host-preflight integrity
sudo ai-agent-runtime-preflight staging /etc/ai-agent/runtime.env
```

The manifest and exact refusal order are documented in
[host bundle](host-bundle.md). Never edit installed bundle files or the manifest
by hand.

## Release and rollback

A merge to `main` publishes immutable images and deploys Staging automatically.
Verify the Staging workflow, public smoke checks, and
`staging-success-<SHA>` evidence. Do not dispatch the inactive Production
workflow.

Rollback only when the previous application can run against the current
forward-only schema:

```sh
sudo ai-agent-deploy rollback staging
sudo ai-agent-deploy health staging
```

See [rollback](rollback.md) for release-record behavior.

## Incident priorities

- Nginx/TLS: keep application ports private; validate DNS, certificate, and
  configuration before reload.
- Redis: ordinary rate limits fail open and accepted asynchronous work remains
  in PostgreSQL; recover the service and monitor outbox drainage.
- PostgreSQL: stop writes, preserve failed state, and follow the verified
  backup/restore procedure.
- Repeated agent contract failures: disable the feature or `agents.enabled`
  rather than increasing retries; retries can multiply provider spend.
- Pre-migration deployment refusal: repair the named preflight condition. Do
  not bypass the wrapper.
- Bad release: use rollback only after checking schema compatibility.
- Suspected credential exposure: revoke at the owning boundary, replace the
  value, and redeploy without copying sensitive evidence.

## Approved agent actions that never settled

A `notification.send@1` execution left `APPROVED` with a positive
`effectAttemptCount` beyond the retry horizon may have reached the provider
without recording an outcome. Do not requeue it blindly.

Look it up at the provider using
`notification.send@1:<toolExecutionId>`. Record the finding for the
organization. If the provider has the request, it sent; if it does not and the
24-hour idempotency window has expired, do not resend under that key.
