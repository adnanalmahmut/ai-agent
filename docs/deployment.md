# Deployment

Staging deploys automatically after a merge to `main` passes CI and immutable
image publishing. Production is not provisioned; its workflow and host
procedures are inactive. See [deployment state](deployment-state.md).

## GitHub Environment contract

Staging uses these names:

| Kind     | Name                  | Purpose                             |
| -------- | --------------------- | ----------------------------------- |
| Variable | `VPS_HOST`            | Static IP or hostname               |
| Variable | `VPS_USER`            | Restricted `deploy` identity        |
| Variable | `VPS_SSH_KNOWN_HOSTS` | Pinned host-key lines               |
| Variable | `DEPLOYMENT_URL`      | Public HTTPS origin                 |
| Secret   | `VPS_SSH_PRIVATE_KEY` | Environment-specific restricted key |

Any provisioned environment must use independent values and an
explicit environment allowlist. Production should require reviewers and a main-only
deployment policy.

## Host contract

The host bundle is installed with
`infra/deploy/install-host-bundle.sh` and recorded in
`/etc/ai-agent/host-bundle.manifest`. The wrapper rejects an incompatible or
modified bundle before migrations. See [host bundle](host-bundle.md).

Install runtime configuration as `root:root` mode `0600` at
`/etc/ai-agent/runtime.env`. The deploy user cannot read it. The authoritative
names-only template is
[`ops/environments/runtime.env.example`](../ops/environments/runtime.env.example).

Compose receives that file for interpolation but uses explicit per-service
environment lists:

- API: database, auth, mail, HTTP, GeoIP, control-plane keyring, and rate limits;
- worker: database, Redis/queue/outbox, agent reconciliation, keyring, and the
  mail fields required for approved notifications;
- migration: `DATABASE_URL` only;
- web, platform, and GeoIP updater: their own settings only.

Image repositories are fixed in the wrapper. References are constructed from
validated digest values, never from runtime configuration.

## Deployment sequence

The wrapper enforces:

1. host-bundle integrity and available disk;
2. runtime configuration validation without printing values;
3. release labels, minimum bundle, and pinned image resolution;
4. required PostgreSQL capabilities;
5. PostgreSQL, Redis, and GeoIP service readiness;
6. one-shot forward migration;
7. API readiness, worker, web, and platform rollout;
8. internal health and public HTTPS smoke checks;
9. atomic rotation of `CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json`;
10. best-effort superseded-image retention.

Application images are pulled sequentially (platform, web, backend, migration)
to limit extraction pressure; the worker shares the backend image. A failure
before release-state rotation leaves the prior recorded release intact.
