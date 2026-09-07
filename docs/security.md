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

## Browser origins

Four surfaces are named explicitly: the public site, the customer application,
the administrative surface and the API. `APP_ORIGIN_PUBLIC`, `APP_ORIGIN_APP`,
`APP_ORIGIN_ADMIN` and `APP_ORIGIN_API` are parsed as origins — scheme, host,
port, nothing else — in
`apps/control-plane/src/infrastructure/config/origins.config.ts`. A value
carrying a path, a query, credentials or a wildcard host is refused rather than
trimmed, because a comparison that looks exact and is not is worse than none.

The app and API origins are derived from `APP_PLATFORM_URL` and
`BETTER_AUTH_URL`, the settings the running system already behaves according
to. Setting them explicitly is allowed and checked: a value that contradicts
what it is derived from fails at boot instead of leaving the deployment with
two answers to one question. Today every surface is served from one host on
different paths, so several of these origins are the same string; that is a
valid configuration, not a degenerate one.

`BETTER_AUTH_TRUSTED_ORIGINS` is an exact allowlist. Every entry is parsed as
an origin and a wildcard is refused outright — there is no prefix, suffix or
pattern matching anywhere in the path from a request's `Origin` to a decision.
An app or admin origin missing from the list fails at boot, because otherwise
every sign-in from it is refused at the origin check and the failure looks like
anything except configuration.

Session cookies are host-only. The cookie is named `__Host-session`, a prefix
browsers enforce: it requires `Secure`, requires `Path=/`, and forbids
`Domain`. During path-based staging, App and the desired Admin mount share the
same host and therefore share that host's session; host-only does not isolate
`/platform` from `/admin`. Later, separate subdomains will have separate
host-only sessions and may require signing in again. A `Domain=` cookie or
`SameSite=None` would undo that boundary and neither is present;
`infra/tests/gateway-origins.sh` continues to prove the future separate-host
isolation over real HTTPS, including a deliberately domain-wide counterexample
so that "no cookie was sent" cannot pass by accident.

Authentication is same-origin on every surface. The browser posts to
`/api/auth/*` on the host it is already on, and that path is served by the
gateway for the customer application and by a narrow in-process forwarder for
the administrative one (`apps/admin/src/app/api/auth/[...all]/route.ts`). The
forwarder relays the method, path, query, body, the browser's own `Origin` and
every `Set-Cookie` separately, and adds no credential or claim; it covers the
auth prefix alone, so the origin is not a way into the rest of the API.
Better Auth's origin and CSRF checks are pinned on and run against the origin
the browser reported.

Moving a surface to a new hostname invalidates the session cookie held on the
old one, and the reader signs in again. That is the intended cost of host-only
cookies and is not worked around with a shared `Domain`.

## An origin is not an authorization

Which host a browser is on says nothing about what the person using it may do.
`Host`, `X-Forwarded-Host`, `Origin` and `Referer` are all written by the
caller. Every administrative operation authorizes the authenticated principal
against the shared policy, per action, and answers identically however the
request describes where it came from —
`apps/control-plane/test/e2e/platform/origin-authority.e2e-spec.ts` replays
each one as an ordinary customer claiming the administrative origin and
asserts the same refusal, with nothing written.

The administrative shell's entry gate is a separate, weaker question: is this a
staff principal at all. It decides what to render, never what may be done.

## OP-3 — administrative exposure gate

The administrative surface is built and testable but is not exposed by any
environment, and it must not be until all four of the following hold. **None of
the first two is implemented, so OP-3 is NOT SATISFIED.**

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Controlled ingress in front of the surface — internal network, access proxy or equivalent barrier, so the sign-in page is not reachable from the open internet | Not implemented |
| 2 | Strong staff authentication — MFA, passkeys or an enterprise identity provider, per the final deployment decision | Not implemented |
| 3 | A secure administrative origin configured: its own hostname, HTTPS, host-only cookie, and that origin in the trusted allowlist | Model in place; no origin configured, because nothing serves one |
| 4 | Backend staff and per-action authorization verified independently of the browser origin | Verified |

Requirements 1 and 2 are deployment work with no code in this repository yet.
Nothing here should be read as claiming the administrative surface is protected
by MFA or by a private network: it is protected by not being deployed.

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
