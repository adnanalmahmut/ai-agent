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
settings, and provider credentials. It can write a credential and can never
read one: no endpoint returns a stored secret and the screen shows no masked
preview, so the only evidence a credential exists is its metadata. Reading it
requires `controlPlane:read`; writing a credential requires the separate
`managedSecret:write`, which `admin` does not hold. A credential's optional
note is stored unsealed and returned by the listing, so the screen refuses to
send one that contains the credential being stored.

An organization's Knowledge tab manages its spaces and documents. It always
asks for the organization in hand rather than the session's active one, and
document rows are tied to the space they were loaded for, so choosing a second
space shows nothing until that space's own rows arrive rather than the previous
space's material under the new heading. Write controls are hidden from a reader
holding only `knowledge:read`, which is UX — the guard behind the endpoints
decides.

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
server and is paid for — but it is not recoverable: the operation id lives only
in the screen's own state, and there is no list endpoint to find it again from,
so leaving the screen loses track of it. The copy says exactly that.

The idempotency key the endpoint requires is minted per submission and survives
only a transport failure, where nobody knows whether the request was accepted;
any answer from the server — a refusal included — means that submission is over
and the next ask is a new key. Generation is billed, so a retry that minted a
fresh key would buy the same answer twice.

Both 403s are distinguished by code rather than status, so a disabled feature
does not read as a missing permission, and the reason a 429 carried is rendered
beneath the message — the per-user rate limit and the organization's in-flight
ceiling share a status and are different problems. The form is hidden from a
reader without `contentIdea:create`, which is UX; the backend decides.

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
