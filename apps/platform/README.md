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
```

Production output is a standalone Next.js Node server running as an
unprivileged user on port 3001. `build` copies static and public assets into the
standalone tree, so `start` exercises the same artifact the image runs. During
local development, root-level `/api/*` requests are rewritten to
`PLATFORM_API_PROXY_TARGET` (default `http://127.0.0.1:3002`); that rewrite is
disabled in production, where host Nginx remains the only public reverse proxy.
Client permission gates are UX only; backend RBAC remains authoritative. See
[`docs/frontend.md`](../../docs/frontend.md) and
[`docs/authentication-rbac.md`](../../docs/authentication-rbac.md).
