# Frontend applications

`apps/web` is the public Next.js 16 application at `/`. It uses App Router,
localized routes, server/public configuration separation, theme support, and a
Better Auth client. Its production image is Next standalone output running as a
non-root user.

`apps/platform` is a React 19 + Vite application mounted at `/platform/`. It
contains authentication, account settings, active-session location, global
administration, organization membership/invitations, the operator control-plane
surface, and permission-gated UI. Client permission gates improve UX; backend
authorization remains decisive.

The control-plane screen (`/admin/control-plane`) edits feature flags, runtime
settings, and provider credentials, and exposes a separately loaded,
cursor-paginated audit-history tab. It can write a credential and can never
read one: no endpoint returns a stored secret and the screen shows no masked
preview, so the only evidence a credential exists is its metadata. The audit
tab renders only closed, safe state projections (never arbitrary audit JSON),
so a future server regression cannot turn an operator's DOM into a credential
exfiltration surface. Reading it requires `controlPlane:read`; writing a
credential requires the separate `managedSecret:write`, which `admin` does not
hold. A credential's optional note is stored unsealed and returned by the
listing, so the screen refuses to send one that contains the credential being
stored.

An organization's Knowledge tab manages its eight code-owned spaces and their
documents. It always asks for the organization in hand rather than the
session's active one, and document rows are tied to the space they were loaded
for, so choosing a second space shows nothing until that space's own rows
arrive rather than the previous space's material under the new heading. The
document API uses bounded, stable cursor pagination and the tab can load later
pages; cursors remain scoped to the same organization and space. Write controls
are hidden from a reader holding only `knowledge:read`, which is UX — the guard
behind the endpoints decides.

An organization's Content ideas tab asks the `content-idea@1` agent for ideas
grounded in that organization's knowledge. Generation is asynchronous, so the
screen shows the operation it was given — queued, then running, then either the
ideas or a failure — rather than a spinner implying an answer is a moment away
from a provider call that might not return. It re-reads the operation on a short
interval, once immediately so the first status shown is not already stale, and
stops on a terminal status; a poll that could not reach the server is ridden out
because the next tick recovers, while a poll the server *refused* stops asking.
A run still going after three minutes is reported as still running rather than
waited on indefinitely. Giving up is not cancelling — the run continues on the
server and is paid for — but its operation id is written to the route query, so
a reload or navigation reconstructs the same authorized operation. A stale,
unreadable, or wrong-organization operation id fails closed and is never shown
under another organization.

The idempotency key the endpoint requires is minted per material request and,
scoped by organization, survives an ambiguous transport failure in session
storage. A reload/retry therefore reuses the uncertain key instead of buying a
second run. Sameness is decided by a SHA-256 digest of the canonical normalized
request; the stored record is only `{ idempotencyKey, requestDigest }`, so no
operator-authored request text — topic, goal, audience, guidance — is written to
browser storage. It is cleared only when acceptance or refusal is unambiguous; a
materially changed request digests differently and receives a new identity.

Both 403s are distinguished by code rather than status, so a disabled feature
does not read as a missing permission, and the reason a 429 carried is rendered
beneath the message — the per-user rate limit and the organization's in-flight
ceiling share a status and are different problems. The form is hidden from a
reader without `contentIdea:create`, which is UX; the backend decides.

An organization's Settings page separates Better Auth's name/slug form from
the application-owned business-settings form. Owners and admins can select the
default content locale, IANA timezone, and ISO currency and maintain bounded
legal name, industry, HTTP(S) website, and business description fields. The
route loads the settings for the organization in the URL, validates before
sending, and refreshes its loader data after a successful replacement. A
server-side version conflict is rendered as a closed organization error so the
screen never silently overwrites a newer edit. Members see the existing
read-only state; the client gate is UX and the backend permission guard remains
authoritative.

The production image serves static files with unprivileged Nginx.

Platform public configuration is compiled into the immutable Vite artifact at
build time. `docker-bake.hcl` passes `VITE_APP_NAME=Feedogo` to the Platform
Docker build; the Dockerfile rejects an empty value and rejects emitted files
that still contain unresolved `%VITE_*%` placeholders. `VITE_*` values are not
runtime settings and must not be added to `/etc/ai-agent/runtime.env` as a way
to alter an already-built Platform image.

Both applications use the shared `@repo/ui` and `@repo/i18n-core` packages.
English and Arabic messages are parity-tested. CI runs Web lint/test/build and
Platform workspace typecheck/lint/tests/build independently; documentation
does not pin volatile test counts.
