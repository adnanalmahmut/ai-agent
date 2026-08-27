# Organization business settings

## Goal

Deliver ORG-01: a small, durable, organization-owned settings foundation for
locale, timezone, currency, and a typed business profile, with an authorized API
and Platform settings surface.

## Context

`Organization` already owns tenant identity, lifecycle, memberships, agent runs,
and knowledge. Better Auth owns its core name/slug/logo fields, while application
columns coexist on the same row and are read through `PrismaService`.

The Platform already has an organization settings screen and the backend has a
path-scoped `OrganizationPermissionGuard`. The product currently has no durable
organization default locale, timezone, currency, or typed business description;
using the legacy free-form `metadata` column would make validation, safe
projection, and future consumption impossible to enforce.

## Scope

- Add first-class `locale`, `timezone`, `currency`, `legalName`, `industry`,
  `websiteUrl`, and `businessDescription` organization fields.
- Add an optimistic `businessProfileVersion` and explicit
  `businessProfileUpdatedAt` for safe replacement semantics.
- Add an organization-path-scoped GET and PUT contract guarded by the existing
  `organization:update` permission.
- Extend the existing Platform organization settings page with the typed form.
- Add schema, service, API/E2E, tenant-isolation, concurrency, and Platform tests.
- Update the narrow owning architecture/backend/frontend/database documentation.

## Non-goals

- Product audit persistence; AUD-01 owns it and will build on this mutation.
- Agent installations, agent-run pinning, scheduling, billing, analytics, brand
  management, custom locales, custom currencies, or arbitrary metadata.
- Changing Better Auth's organization update route or the existing name/slug
  profile form.
- Reading or changing Staging, Production, secrets, deployment state, or OPS-03
  documentation.

## Constraints

- Organization ownership and path-scoped authorization are mandatory.
- Only the application's supported locales (`ar`, `en`) are accepted.
- Timezones must resolve as IANA identifiers through the runtime's `Intl`
  implementation; currencies must be ISO 4217 codes supported by `Intl`.
- The PUT body is strict and field-owned; no spreads or arbitrary JSON may reach
  Prisma.
- Nullable business text is bounded and empty strings normalize to `null`.
- Website URLs are limited to HTTP(S).
- Concurrent writers use optimistic compare-and-swap; a stale change returns a
  conflict rather than overwriting a newer value.
- The migration is additive and forward-compatible with the previous release.

## Architecture and decisions

- Store the settings on `Organization`, not in a generic key/value table. These
  are core product fields with stable types and one owner.
- Reuse `organization:update` rather than inventing a second authority for the
  same settings screen. Organization admins and owners may read/write; members
  and outsiders are refused before body validation.
- Use a full-replacement PUT. Optional business fields are explicit `null`, so
  omission cannot accidentally retain stale state and mass assignment cannot
  create a hidden field.
- `businessProfileVersion` starts at 1. A real write matches `(id, version)` and
  increments it atomically. A stale body that already equals current state is a
  harmless idempotent success; a stale body that would change state is 409.
- Defaults are the existing app default locale (`ar`), `UTC`, and `USD` so every
  existing organization becomes immediately readable without a backfill job.

## Acceptance criteria

- Authorized organization admins/owners can read and replace their settings.
- Members, outsiders, and global administrators without membership cannot read
  or mutate them.
- A guessed organization id and a cross-tenant id are indistinguishable from a
  missing organization at the application boundary.
- Unsupported locales, invalid timezones, invalid currencies, non-HTTP(S) URLs,
  oversized fields, unknown keys, and mass-assignment attempts are rejected.
- A no-op write does not increment the version or timestamp.
- Two writers using the same version cannot silently overwrite one another.
- Platform renders current values, validates input, saves through the application
  API, reports conflicts/refusals, and refreshes the route data after success.
- Existing organization lifecycle and Better Auth behavior remain unchanged.

## Validation

- Focused backend unit tests for normalization, validation, no-op, and CAS.
- Backend E2E for authorized read/write, negative roles, cross-tenant reads and
  writes, guard-before-pipe behavior, and stale-version conflicts.
- Focused Platform component/hook/API tests.
- Prisma format, validate, generate, migration apply-from-current and project
  migration checks.
- `pnpm agents:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter backend test:e2e`
- `pnpm build`
- `ops/tests/documentation.sh`
- `git diff --check`

## Required evidence

- Focused test output and aggregate validation results.
- Migration SQL and schema diff.
- Negative tenant/authorization E2E results.
- Final reviewed diff, commit SHA, PR URL/base/head, and final-head GitHub checks.

## Risks and rollback

- `Intl` support differs if the runtime is built without full ICU. Validation is
  tested in the repository's actual Node/container environment and stores only
  canonical accepted identifiers.
- Additional non-null columns use defaults, so the previous application ignores
  them safely. Rollback is the previous image; the additive columns remain until
  a separately planned contraction.
- The profile is not yet consumed by agents, billing, scheduling, or analytics.
  This PR establishes the durable typed source those later slices may read.

## Progress

- [x] Shared discovery and dependency graph
- [x] Design and acceptance contract
- [x] Schema and migration
- [x] Backend service, API, and tests
- [x] Platform UI and tests
- [x] Documentation
- [x] Focused validation
- [x] Self-review and specialist reviews
- [x] Aggregate validation
- [ ] PR handoff

## Decision log

- 2026-08-27: ORG-01 is independent from main. The current organization/RBAC/UI
  foundation is sufficient.
- 2026-08-27: AUD-01 is a real child because its first safe product event will
  project this mutation; ORG-01 deliberately does not create audit rows itself.
- 2026-08-27: core settings use columns rather than the legacy `metadata` string
  or a new generic settings registry.
- 2026-08-27: code review found and repaired the identical-concurrent-request
  edge: after a missed CAS the service re-reads once, accepts an identical
  winner as idempotent success, and still conflicts on a different winner.
- 2026-08-27: security review traced the HTTP, authorization, persistence, and
  rendering paths and identified no high-confidence vulnerability. The route is
  globally authenticated and path-tenant guarded before its strict DTO, Prisma
  owns query parameterization, and React uses escaped text/value sinks.

## Blockers

None.
