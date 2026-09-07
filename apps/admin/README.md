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

Development serves on port 3003 and expects the backend on 3002, so the local
address is `http://localhost:3003/admin`; the production output is a standalone
Next.js Node server on 3003 running as an unprivileged user. `basePath` is `/admin`, because the deployment serves every
surface from one hostname. It is a build-time constant — Next.js resolves the
router, the asset URLs and the route handlers against it when the application
is compiled — so serving this application from a hostname of its own later
means removing it, not reconfiguring it.

Three consequences of the base path, each of them a framework behaviour rather
than a choice, and each asserted against a running server by
`scripts/probe-standalone.mjs` (`pnpm --filter admin test:standalone`, after a
build):

- a route handler is called with the base path already removed, so the auth
  forwarder hands the Control Plane its own `/api/auth/*` path;
- middleware still sees it on `request.url`, so `src/proxy.ts` strips it before
  reading the locale and puts it back on the redirect;
- the health route answers at `/admin/health`, which is what the container
  healthcheck probes.

`ADMIN_API_ORIGIN` says where the Control Plane is and is read per request, so
the image carries no address of its own. The browser signs in same-origin
against `/admin/api/auth/*`, which `src/app/api/auth/[...all]/route.ts`
forwards to that origin — method, path, query, body and headers through, and
status, headers and every `Set-Cookie` back, with no authentication logic of
its own.
That path is the same in development, in the standalone server and in the
container, which is what makes a real login work outside a dev fixture. Two
consequences worth knowing: the session cookie is `__Host-session`, so it is
host-only to whichever origin serves it, and Better Auth checks the origin the
browser reported — `http://localhost:3003` is trusted for local development,
and a deployed origin has to be added per environment. Only `/api/auth` is
forwarded; an open proxy over the API would make this origin a way into every
Control Plane route from a browser.

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

The image is published with every release as an optional component, and only
the staging Compose profile runs it — behind a client allowlist at the gateway,
and never in production. An allowlisted address is not a permission: the
backend authorizes every administrative request from the session, whichever
surface it arrives from. See [`docs/frontend.md`](../../docs/frontend.md) and
[`docs/security.md`](../../docs/security.md).
