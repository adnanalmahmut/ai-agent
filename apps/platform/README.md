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
```

Production output is a standalone Next.js Node server running as an
unprivileged user. Host Nginx remains the only public reverse proxy.
Client permission gates are UX only; backend RBAC remains authoritative. See
[`docs/frontend.md`](../../docs/frontend.md) and
[`docs/authentication-rbac.md`](../../docs/authentication-rbac.md).
