# Admin

Next.js 16 App Router administrative surface. It is a shell: a sign-in screen,
a server-side staff authorization gate, a refusal state, a health endpoint and
a bilingual frame. No administrative module has moved into it yet — account
administration and control-plane configuration are still owned by
[`apps/app`](../app/README.md) and are reached at `/platform/*`.

```sh
pnpm --filter admin dev
pnpm --filter admin typecheck
pnpm --filter admin lint
pnpm --filter admin test
pnpm --filter admin build
pnpm --filter admin start
```

Development serves on port 3003 and expects the backend on 3002; the
production output is a standalone Next.js Node server on 3003 running as an
unprivileged user. There is no `basePath`: this surface is served from an
origin of its own rather than from a path on somebody else's, and which origin
that is has not been decided here.

Authentication is the deployment's existing one. This application has no
accounts, no passwords and no session format of its own — it signs in against
the same Better Auth deployment and reads the same session. What it adds is a
second question, asked on the server before anything protected renders: does
this session belong to staff? The answer comes from
[`@repo/authz-policy`](../../packages/authz-policy), which classifies a global
role by the platform-wide actions the policy grants it, so this surface and the
backend cannot come to disagree about who administers the installation.

There is no way to create an account here, and there will not be one: staff are
provisioned through the existing account administration. `src/app/routes.test.ts`
fails if a route, a link or a message appears that suggests otherwise.

The gate is `src/app/[locale]/(protected)/layout.tsx` and it is default-deny —
a signed-out request is redirected to sign in, a signed-in request without
staff authority is refused in place, and an authorization that could not be
evaluated is refused too. Client permission gates are not part of it; a browser
never receives the session helper or the server configuration, which
`src/lib/client-boundary.test.ts` proves by walking the import graph. Backend
authorization remains authoritative: a screen this gate admits is not a screen
whose API calls are permitted.

The image is buildable (`docker buildx bake admin`) and is deliberately not a
release component. See [`docs/frontend.md`](../../docs/frontend.md).
