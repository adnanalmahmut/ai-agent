# Frontend applications

`apps/web` is the public Next.js 16 application at `/`. It uses App Router,
localized routes, server/public configuration separation, theme support, and a
Better Auth client. Its production image is Next standalone output running as a
non-root user.

`apps/platform` is a Next.js 16 App Router application mounted at `/platform/`.
It contains authentication, account settings, active-session location, global
administration, organization membership/invitations, the operator control-plane
surface, and permission-gated UI. Client permission gates improve UX; backend
authorization remains decisive.

The control-plane screen (`/admin/control-plane`) edits feature flags, runtime
settings, and provider credentials, and exposes a separately loaded,
cursor-paginated audit-history tab. It can write a credential and can never
read one: no endpoint returns a stored secret and the screen shows no masked
preview, so the only evidence a credential exists is its metadata. The audit
tab renders closed, safe state projections rather than arbitrary audit JSON, so
a future server regression cannot turn an operator's DOM into a credential
exfiltration surface. Its one displayed payload field is a managed secret's
encryption key version, gated on the backend's own version grammar under a
tighter length cap and replaced by a "not shown" term when it does not conform —
see [security.md](security.md) for what that gate does and does not promise. Reading it requires `controlPlane:read`; writing a
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

An organization's Approvals tab is the human-approval surface for proposed
agent actions. It lists proposals by decision state, shows what the agent wrote
and the member it named — resolved by the server at read time, so a member who
has since left is shown as gone rather than as a stale name — and offers approve
and reject to a viewer whose membership role holds `agentActionApproval:decide`.
That gate is UX; the guard behind the endpoints decides, and a 409 from a
decision made by somebody else first is shown as exactly that. After approval
the row keeps reporting the execution's state (queued, sent, not sent, outcome
unknown) from the same read, so the screen never claims a message left before
the worker recorded that it did. Nothing on the tab edits a proposal: a person
decides on it as written.

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

Each returned idea carries an action that starts a project from it, shown only
to a member who may create one. What it sends is the operation's id and the
card's index — never the idea's text — so the screen cannot persist something
the agent did not say even by accident. Its idempotency key is derived from that
pair rather than minted per click, which makes a double-click, a retry after a
dropped connection, and a click after a reload all the same request.

The Projects tab lists what the organization has committed to, newest first, and
grows by appending the next cursor page rather than replacing the list. A
project's detail view leads with the brief the ideas were generated from — topic
and goal always, audience and guidance only when the original request named
them, because an empty row would read as "none" where the truth is "not stated"
— then shows the stored idea beside its first draft; an unwritten
draft says so rather than rendering blank, because a draft with no body is the
normal state in this release and an empty card would read as a rendering
failure. A project that is absent and one belonging to another organization are
the same answer, so the page cannot be used to probe for ids.

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
sending, and refreshes its server-rendered route data after a successful
replacement. A server-side version conflict is rendered as a closed
organization error so the
screen never silently overwrites a newer edit. Members see the existing
read-only state; the client gate is UX and the backend permission guard remains
authoritative.

The production image runs a standalone Next.js server as an unprivileged user;
host Nginx remains the public reverse proxy.

Platform public configuration is compiled into the immutable Next.js artifact
at build time. `docker-bake.hcl` passes `NEXT_PUBLIC_APP_NAME=Feedogo` to the
Platform Docker build, and the Dockerfile rejects an empty value. Public build
values are not runtime settings and must not be added to
`/etc/ai-agent/runtime.env` as a way to alter an already-built Platform image.
Server Components use the server-only `PLATFORM_API_ORIGIN` to reach the NestJS
service over the Compose network and forward the incoming cookie; browser API
traffic remains same-origin under `/api`.

Both applications use the shared `@repo/ui` and `@repo/i18n-core` packages.
English and Arabic messages are parity-tested. CI runs Web lint/test/build and
Platform workspace typecheck/lint/tests/build independently; documentation
does not pin volatile test counts.
