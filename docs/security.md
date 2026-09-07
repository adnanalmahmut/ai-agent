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
`Domain`. On staging, App and Admin are mounted on the same host and therefore
share that host's session; host-only does not isolate `/platform` from
`/admin`, and nothing here should be read as claiming it does. `Path=/admin`
would not fix that either — a path is not a security boundary in a browser,
and narrowing it would break `__Host-` without buying isolation. Later, separate subdomains will have separate
host-only sessions and may require signing in again. A `Domain=` cookie or
`SameSite=None` would undo that boundary and neither is present;
`infra/tests/gateway-origins.sh` continues to prove the future separate-host
isolation over real HTTPS, including a deliberately domain-wide counterexample
so that "no cookie was sent" cannot pass by accident.

Authentication is same-origin on every surface. The browser posts to the auth
path on the host it is already on: `/api/auth/*` for the customer application,
served by the gateway, and `/admin/api/auth/*` for the administrative one,
served by a narrow in-process forwarder
(`apps/admin/src/app/api/auth/[...all]/route.ts`) that hands the Control Plane
its own `/api/auth/*` path. `https://staging.feedogo.com` is the trusted
origin; `https://staging.feedogo.com/admin` is a path and is not an origin, and
no path appears in the allowlist. The
forwarder relays the method, path, query, body, the browser's own `Origin` and
every `Set-Cookie` separately, and adds no credential or claim; it covers the
auth prefix alone, so the origin is not a way into the rest of the API.
Better Auth's origin and CSRF checks are pinned on and run against the origin
the browser reported.

Moving a surface to a new hostname invalidates the session cookie held on the
old one, and the reader signs in again. That is the intended cost of host-only
cookies and is not worked around with a shared `Domain`. It is also the cost of
the eventual move of the administrative surface to a hostname of its own: the
mount point is a build-time `basePath` in `apps/admin`, so that move removes it
rather than reconfiguring it, and it is a deliberate migration rather than
something either topology can be made to straddle.

## Administrative ingress, on staging only

The administrative surface is served at `/admin` on the staging host, behind a
client allowlist at the gateway. Two locations carry it — `= /admin` and
`^~ /admin/` — and both include the same restriction, so the pages, the assets
under `/admin/_next/` and the auth forwarder under `/admin/api/auth/` are all
behind it. Protecting the page and leaving the way in open would protect
nothing.

The allowlist is a root-owned file of address ranges, one per line, at
`/etc/ai-agent/admin-staging-allowed-cidrs`.
`infra/gateway/nginx/install-nginx.sh` reads it and renders `allow` directives
followed by an unconditional `deny all`. It fails closed in every direction: a
missing file, an empty one and one holding only comments all install the route
with nothing but the denial, and a malformed entry is refused rather than
skipped, leaving the previously validated configuration in force. A `/0`
prefix and the unspecified address are refused outright, so no allowlist can be
written that admits the internet. The route is installed on staging hosts only,
decided from `/etc/ai-agent/environment` rather than from what the caller asked
for; production installs no administrative route at all and its Compose
composition has no administrative service to route to.

Nginx matches the allowlist against the connection it is serving. There is no
`real_ip_header` configuration anywhere in the gateway, so `X-Forwarded-For`,
`X-Real-IP` and their variants — all written by the client, since no load
balancer sits in front of this host — cannot satisfy it.
`infra/tests/gateway-admin-ingress.sh` runs the real installer against real
Nginx and asserts each of these, including six spoofed-header attempts from an
address the allowlist excludes.

An ingress restriction is not an authorization. It decides who may reach the
surface; it says nothing about what they may do, and reaching it from an
allowlisted address makes nobody staff. The section above and the OP-3 table
below are where that boundary is stated.

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

The administrative surface is served on staging behind an ingress restriction,
and is not exposed by production, which must remain the case until all four of
the following hold. **Requirement 2 is not implemented and requirement 1 holds
for staging only, so OP-3 is NOT SATISFIED.**

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Controlled ingress in front of the surface — internal network, access proxy or equivalent barrier, so the sign-in page is not reachable from the open internet | Staging: a fail-closed client allowlist at the gateway. Production: no administrative route and no ingress control for one |
| 2 | Strong staff authentication — MFA, passkeys or an enterprise identity provider, per the final deployment decision | Not implemented |
| 3 | A secure administrative origin configured: its own hostname, HTTPS, host-only cookie, and that origin in the trusted allowlist | Model in place; staging serves the surface on a path of the shared host, so it has no origin of its own and shares that host's session |
| 4 | Backend staff and per-action authorization verified independently of the browser origin | Verified |

An address allowlist is a barrier, not strong authentication, and it is
configured per host rather than by this repository — a staging host whose
allowlist file has not been written serves the route to nobody. Requirement 2
is deployment work with no code here yet, and requirement 3 waits on a
hostname decision. None of those controls exists: no MFA, no passkeys, no
enterprise identity provider, no private network, no access proxy. What
production has is that it serves no administrative route at all. What staging
has is an address allowlist, and the same backend authorization every other
surface is subject to.

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
