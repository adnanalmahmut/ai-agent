# Platform Next.js migration

## Goal

Replace the `apps/platform` React/Vite/React Router SPA with a Next.js 16.3 App Router application in three stacked pull requests while preserving its public URLs, authentication and authorization behavior, localization, product UI, backend API boundary, tests, and reverse-proxy topology.

## Context

The Platform is the repository's authenticated operations UI. PR 1 established its Next.js App Router route tree, server authentication boundaries, locale proxy, and transitional standalone runtime at `/platform/`; the NestJS API and Better Auth remain authoritative at same-origin `/api`. PR 2 removes the superseded React Router feature/test layer and restores browser-level coverage for the route contracts.

Baseline anchor: `f8e958235bd69dae893f32d3bcfa2103df2caf4f`.

## Scope

- Next.js App Router, route groups, localized route tree, layouts, and boundaries in `apps/platform`.
- Server-side session resolution and protected/guest redirects through the existing backend.
- Migration of React Router loaders, hooks, outlets, links, tests, and route assertions.
- Next standalone container runtime, Compose/bake/CI/operator assertions, host proxy compatibility, and owning documentation.
- Removal of Vite, React Router, SPA index/runtime, and Vite-specific public configuration.

## Non-goals

- Backend business-logic or database changes.
- New product features, visual redesign, state-management replacement, or a shared frontend framework.
- Combining `apps/web` and `apps/platform`.
- Production provisioning, manual deployment, merging, or auto-merge.

## Constraints

- Preserve `/platform/{locale}/...`, `en`/`ar`, deterministic URL locale selection, `APP_LOCALE`, and RTL/LTR behavior.
- Anonymous sessions redirect before protected UI renders; backend/network failure must not masquerade as sign-out.
- Backend authorization remains decisive; client gates remain UX only.
- Server Components are the default; Client Components are limited to interactive boundaries.
- Server reads forward request cookies to a server-only internal backend origin and opt out of caching.
- Every PR must be coherent and green against its declared base; PR 2 depends on PR 1 and PR 3 depends on PR 2.
- Preserve unrelated `.vscode/settings.json` work and stage explicit paths only.

## Acceptance criteria

- PR 1 targets `main`, PR 2 targets PR 1, and PR 3 targets PR 2; all remain open for human review.
- Next App Router is the only runtime routing authority and all existing route contracts remain reachable.
- Protected and guest-only redirects, safe `returnTo`, invitations, verification, and reset flows retain their behavior.
- All feature surfaces and meaningful tests are migrated without deleting coverage.
- The final Platform image runs the standalone Next Node server on the existing loopback/reverse-proxy boundary.
- No Vite, React Router, SPA `index.html`, `VITE_*`, or obsolete static-Nginx platform runtime remains.
- Final repository validation and all final-head PR checks pass.

## Validation

At each PR boundary:

- `pnpm --filter platform typecheck`
- `pnpm --filter platform lint`
- `pnpm --filter platform test`
- `pnpm --filter platform build`
- relevant browser/runtime and architecture checks
- `git diff --check`

Final stack:

- `pnpm agents:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm --filter backend test:e2e`
- `ops/tests/documentation.sh`
- container image build/start/health and reverse-proxy contract checks
- Playwright Platform smoke

## Required evidence

- Baseline results and preserved invariant record in the ignored migration state.
- Reviewable route tree and architecture tests.
- Browser evidence for locale, direct deep links, 404s, and auth redirects.
- Container build/start/health evidence.
- PR URLs, bases, head SHAs, and final-head CI states.

## Git and PR policy

- PR 1: `refactor/platform-next-01-foundation` → `main`.
- PR 2: `refactor/platform-next-02-features` → PR 1 branch.
- PR 3: `refactor/platform-next-03-cutover` → PR 2 branch.
- Never force-push, merge, enable auto-merge, deploy manually, or operate Production.

## Decision log

- 2026-09-03: use repository-compatible Next.js `16.3.0`, React `19.2.8`, and `next-intl` `4.13.x`.
- 2026-09-03: preserve `/platform` with Next `basePath`; route `href` values remain base-less because Next applies the base automatically.
- 2026-09-03: use nested App Router layouts for locale, guest-only, protected, and organization data boundaries.
- 2026-09-03: browser API calls remain relative `/api`; server reads use a dedicated server-only backend origin and forward cookies.
- 2026-09-03: keep existing interactive feature components during migration, converting only their router dependencies and entry boundaries.
- 2026-09-03: use a locale catch-all route so unknown descendants render the application's localized not-found boundary instead of Next's generic root 404.
- 2026-09-03: treat the availability request fired by the content-idea mount effect as the browser test's hydration signal before interacting with controlled fields.
- 2026-09-03: keep root-level browser API calls same-origin in development with a development-only external rewrite; production continues to route `/api` at host Nginx.
- 2026-09-03: package public and static assets into the standalone tree during `postbuild`, so local smoke, CI, and the container execute the same deployable artifact.
- 2026-09-03: replace the `next-themes` client-rendered bootstrap script after the live Next MCP loop exposed its React 19 runtime warning; a server-rendered pre-hydration script plus a narrow local provider preserves the same light/dark/system contract without runtime errors.

## Progress

- [x] Synchronize and verify baseline `main`.
- [x] Record URL, locale, auth, API, and runtime invariants.
- [x] Read repository workflow, installed Next 16.3 guidance, and current primary documentation.
- [x] PR 1 — Next foundation, routing, auth, and i18n.
- [x] PR 2 — feature and test migration.
- [x] PR 3 — runtime/deployment cutover, cleanup, and documentation.
- [ ] Final CI inspection and human handoff.

## Outcome

The Platform now has one routing and runtime authority: Next.js 16.3 App Router.
The three-PR stack preserves the `/platform/{locale}/...` contract, moves auth
and route protection to server layouts, retains the existing interactive
product features, removes React Router and the Vite/static-Nginx runtime, and
ships a self-contained standalone Node server on loopback port 3001. Live
Next.js MCP plus browser inspection caught and removed two hydration errors
that static checks did not expose. Browser API traffic remains same-origin;
server reads retain their server-only uncached NestJS boundary.

## Blockers

None. Final-head CI inspection remains before this plan moves to `completed/`.
The recursive workspace test reproduced the recorded five-second CPU-contention
timeout in two interaction-heavy settings cases. Their assertions and behavior
are unchanged, but the cases now declare a 15-second budget; the recursive
backend, web, and Platform suites subsequently passed together.
