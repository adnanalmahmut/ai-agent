# Frontend applications

Both frontends use Next.js 16 App Router, React 19, next-intl, Tailwind CSS 4,
and shared components from `packages/ui`. Arabic and English routes are
locale-prefixed and support right-to-left layout.

## Public web

`apps/web` serves the public site at `/`. Its route tree is intentionally
small; shared visual primitives and locale contracts come from workspace
packages. Production uses Next.js standalone output.

## Platform

`apps/platform` is mounted at `/platform`. Its route groups separate guest
authentication screens from the authenticated application. The private server
layout resolves the session before rendering the platform shell.

Implemented screens cover:

- sign-in, sign-up, verification, password reset, and invitation acceptance;
- account settings and active sessions;
- organizations, members, invitations, settings, and lifecycle actions;
- knowledge, content ideas, content projects, and tool approvals;
- platform users and control-plane configuration.

Routes compose feature components; feature behavior lives under
`src/features`. Browser requests to application endpoints pass through the
central API boundary under `src/lib`; Better Auth protocol calls pass through
the auth feature. During development, Next.js rewrites root `/api/*` requests
to `PLATFORM_API_PROXY_TARGET` (default `http://127.0.0.1:3002`). Production
uses host Nginx for that routing.

Server-only configuration is separated from browser-safe public configuration.
Client permission checks control presentation only. The API rechecks the
organization named in the request path and remains authoritative.

The boundaries above are enforced by standard tooling rather than by a
repository policy suite. `apps/platform/eslint.config.mjs` restricts direct
`fetch`, the Better Auth entry points, repeated mount paths, hard deletes, and
untranslated user-facing strings. The Next.js build rejects a `server-only`
module reaching a client component. The session gate on the private route
group and the agreement between `basePath` and the mount-path constant are
covered by tests beside the code they describe. Everything else about route
composition is convention, not a check.

## Shared packages

- `packages/ui` owns shared components, hooks, fonts, and global styles.
- `packages/i18n-core` owns supported locale identifiers and shared parsing.

Each application owns its messages and product-specific features.

## Commands

```sh
pnpm dev:web
pnpm dev:platform
pnpm --filter web test
pnpm --filter platform test
pnpm --filter platform test:e2e
```

See [authentication and RBAC](authentication-rbac.md) for authorization
boundaries and the app-local READMEs for complete command lists.
