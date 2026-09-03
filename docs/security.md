# Security model

This document identifies enforced trust boundaries. Detailed behavior belongs
in the linked subsystem documentation and source.

## Network and request trust

- Host Nginx is the only public listener. Application ports bind to loopback;
  PostgreSQL and Redis stay on private Docker networks.
- Nginx overwrites forwarding headers. The backend trusts exactly one proxy hop
  in deployed environments and none locally.
- Ordinary API limits use atomic Redis windows and fail open with an observable
  warning if Redis is unavailable. Better Auth sensitive routes use an
  independent database limiter.
- MCP validates browser `Origin` against configured trusted origins and
  forwards only protocol headers to the MCP SDK; the application session cookie
  stays outside that library.

See [networking and real IP](networking-real-ip.md) and
[rate limiting](rate-limiting.md).

## Identity, authorization, and tenant isolation

Platform and organization RBAC are separate. Backend guards authorize the
organization named in the path; a selected session organization and browser
permission gate are not authority. User and organization lifecycle is
reversible, and hard deletion is not exposed.

Organization-owned database relations and vector searches carry tenant
predicates. Composite keys enforce tenant agreement where one organization row
references another. The first super administrator is a host-authorized bootstrap
operation, while database enforcement prevents concurrent account changes from
leaving no usable super administrator.

See [authentication and RBAC](authentication-rbac.md) and
[database](database.md).

## Credentials and provider data

Runtime secrets exist only in the root-owned host environment. Compose passes an
explicit allowlist to each process. Provider credentials stored through the
control plane use authenticated AES-256-GCM ciphertext under a bootstrap
keyring; no API returns their values, and plaintext is passed directly to the
adapter that needs it.

Audit projections cannot represent credential material. Provider credentials,
prompts, responses, headers, raw errors, and stacks do not enter run
diagnostics, queue payloads, audit records, logs, or client-visible errors.
Provider outputs are parsed against application-owned schemas before storage.

See [configuration](configuration.md).

## Agents and external effects

Agent definitions declare bounded context, allowed models, and maximum exact
tool versions. Organization installation narrows that authority. Runs pin the
effective definition, installation version, model policy, model, and pricing
revision at acceptance.

Retrieved knowledge is organization-scoped, budgeted, fenced as untrusted quoted
material, and kept out of agent instructions. A document can still influence a
model; tools and side effects therefore have independent authorization.

Read-only tools pass through the audited gateway. A side-effecting tool can only
create a proposal. An authorized person decides, and the worker revalidates the
approval digest, organization state, grant, and recipient immediately before an
idempotent provider call. Ambiguous outcomes stop as `OUTCOME_UNKNOWN`.

MCP exposes the same registry, grants, gateway, audit rows, and approval
lifecycle. Sessions have an absolute lifetime and durable call ceiling.
Reconnects do not create authority.

See [backend](backend.md) and [queue/outbox](redis-queue-outbox.md).

## Delivery and recovery

The deployment key is restricted to a forced command and cannot read runtime
secrets or backups. Releases are immutable digest-addressed sets with
provenance/SBOM. Deployment verifies artifact lineage, image identity, host
compatibility, health, and smoke tests. Migrations run before application
replacement and block a failed release.

Backups and restore operations are root-only. Production is not provisioned and
must not be operated. See [deployment](deployment.md), [host bundle](host-bundle.md),
and [backup/restore](backup-restore.md).

Never log secrets, tokens, cookies, session IDs, private keys, raw environment
values, or raw GeoIP request data.
