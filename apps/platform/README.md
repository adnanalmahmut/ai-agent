# Platform

Next.js 16 App Router operations application, mounted at `/platform/` behind
host Nginx. It owns account settings, active sessions, global administration,
organizations, invitations, and permission-aware navigation.

```sh
pnpm --filter platform dev
pnpm --filter platform typecheck
pnpm --filter platform lint
pnpm --filter platform test
pnpm --filter platform build
pnpm --filter platform start
pnpm api:types
```

Production output is a standalone Next.js Node server running as an
unprivileged user on port 3001. `build` copies static and public assets into the
standalone tree, so `start` exercises the same artifact the image runs. During
local development, root-level `/api/*` requests are rewritten to
`PLATFORM_API_PROXY_TARGET` (default `http://127.0.0.1:3002`); that rewrite is
disabled in production, where host Nginx remains the only public reverse proxy.
Client permission gates are UX only; backend RBAC remains authoritative.

The API boundary this application talks through — the transports, the wire
protocol for a response and its errors, and the generated OpenAPI types — is
[`@repo/api-client`](../../packages/api-client/README.md). Its generated file
is written by `pnpm api:types` from the backend's Application OpenAPI document
and must not be hand-edited; `pnpm api:types:check` is the merge gate that
proves the committed copy is current. See
[`docs/frontend.md`](../../docs/frontend.md) and
[`docs/authentication-rbac.md`](../../docs/authentication-rbac.md).
