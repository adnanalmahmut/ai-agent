# Platform

React 19 + Vite operations application, mounted at `/platform/` behind host
Nginx. It owns account settings, active sessions, global administration,
organizations, invitations, and permission-aware navigation.

```sh
pnpm --filter platform dev
pnpm --filter platform typecheck
pnpm --filter platform lint
pnpm --filter platform test
pnpm --filter platform build
```

Production output is static and served by an unprivileged Nginx container.
Client permission gates are UX only; backend RBAC remains authoritative. See
[`docs/frontend.md`](../../docs/frontend.md) and
[`docs/authentication-rbac.md`](../../docs/authentication-rbac.md).
