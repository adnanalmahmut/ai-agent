# Organization product audit trail

## Goal

Introduce the smallest durable organization-scoped product audit trail needed
to make meaningful tenant mutations accountable, beginning with replacement of
the ORG-01 business profile.

## Context

ORG-01 added a strict, path-authorized business-profile replacement with
optimistic concurrency. It deliberately did not persist audit history. The
repository already has a control-plane audit log, but that log belongs to
platform operators and has different authorization, resources, and sensitive
data rules. Product history needs its own tenant-owned model and read surface.

AUD-01 is therefore a real child of ORG-01: its first action vocabulary, safe
state projection, atomic writer, and tests consume the business-profile
mutation introduced by PR 1.

## Scope

- Add an append-only `OrganizationAuditEvent` model and additive migration.
- Define a closed initial product action,
  `organizationBusinessProfile.replaced`, and its closed safe before/after
  state.
- Append exactly one event in the same PostgreSQL transaction as each real
  business-profile replacement.
- Attribute the event to the authenticated user that performed the mutation.
- Add a bounded, newest-first, cursor-paginated organization audit read API.
- Reuse the path-scoped organization authorization boundary and test tenant
  isolation, role visibility, safe projection, immutability, atomicity,
  idempotency, and concurrent writers.
- Update the narrow owning backend, database, security, and feature-inventory
  documentation.

## Non-goals

- A generic event bus, event store, event-sourcing architecture, or replay
  system.
- Application logs, observability/security logs, or an agent execution
  timeline.
- Auditing Better Auth, organization lifecycle, knowledge, content ideas,
  control-plane mutations, or future agent-installation work in this PR.
- Arbitrary metadata, arbitrary request bodies, headers, credentials, secrets,
  tokens, cookies, or session identifiers in audit rows.
- A Platform activity screen. The authorized paginated API is the visibility
  surface for this bounded foundation; a UI can be added only with separately
  approved product scope.
- Retention, export, search, reporting, webhooks, queues, or notifications.
- Reading or changing Staging, Production, secrets, deployment state, or the
  stale OPS-03 documentation carried outside this train.

## Constraints

- Every row is owned by exactly one organization and every read predicate is
  rooted in the organization id from the authorized request path.
- Product audit data stays separate from `ControlPlaneAuditEvent`; neither
  authorization domain may reveal the other's history.
- The initial writer accepts only a compile-time closed action and closed safe
  state. There is no general-purpose metadata argument.
- Business-profile before/after state contains only the typed profile version,
  locale, timezone, currency, and bounded nullable business fields. It excludes
  request envelopes and unrelated organization columns.
- A real mutation and its audit row commit or roll back together. The audit
  service exposes no standalone write path.
- No-op, stale-conflict, invalid, and unauthorized requests append nothing.
- Rows are immutable through the application: no update/delete service method
  and no update/delete HTTP route.
- Listing defaults to 25 items, refuses limits outside 1..100, and uses a
  `(occurredAt, id)` descending keyset cursor.
- The migration is additive and rollback-compatible with the ORG-01 image.

## Architecture and decisions

- `OrganizationAuditEvent` stores `organizationId`, `occurredAt`, nullable
  `actorUserId`, `action`, `subjectType`, `subjectId`, and nullable JSON
  `before`/`after`. The organization foreign key is `Restrict`; actor identity
  is intentionally not a foreign key so attribution can survive a future user
  lifecycle change.
- The first action is `organizationBusinessProfile.replaced`; its subject type
  is `organizationBusinessProfile` and subject id is the organization id. Both
  are explicit persisted facts rather than inferred later from routes.
- Full safe before/after profile state is warranted for this settings mutation:
  accountability requires knowing the value that was replaced and the value
  that took effect. A changed-field mini-language would add machinery without
  reducing the sensitive-data surface, because every allowed field is already
  bounded and explicitly owned.
- `OrganizationBusinessProfileService.replace` receives `actorUserId` and runs
  its read, conditional update, and audit append through one Prisma interactive
  transaction. PostgreSQL's default `ReadCommitted` isolation works with the
  existing compare-and-swap: a losing identical request re-reads the winner and
  returns idempotently without a second event; a different loser returns 409.
- `GET /organizations/:organizationId/audit-events` reuses
  `organization:update`. The initial history reveals before/after values from
  the same settings surface, so admins and owners may read it while members,
  outsiders, and global administrators without membership may not. A separate
  audit permission would duplicate authority for a strictly smaller exposure.
- The API offers only pagination, not arbitrary subject/action filters. The
  first bounded collection has one action; filters become justified only when
  a real product consumer needs them.
- Control-plane cursor mechanics are followed as a proven local convention but
  not generalized into shared audit infrastructure; the domains remain
  deliberately independent.

## Acceptance criteria

- An authorized owner/admin profile replacement appends one organization-owned
  event with actor, action, subject, timestamp, and exact safe before/after
  state.
- The profile change and event are atomic: if the append fails, the profile
  remains unchanged; an acknowledged profile change always has its event.
- A no-op or repeated identical request does not create another event.
- Two concurrent different replacements yield one success, one conflict, and
  one event; two concurrent identical replacements yield two successful HTTP
  responses but one durable mutation and one event.
- Invalid and unauthorized writes create no events and reveal no audit schema
  to a caller refused by the path guard.
- Owners/admins can page their organization's history newest first. Members are
  refused with 403; outsiders and global administrators without membership see
  404; no caller can page another tenant's rows.
- Invalid cursors and page sizes are refused, and authorization runs before
  query validation.
- Audit rows expose no arbitrary request data, unrelated organization data, or
  secret-like canary sent in an unknown field.
- No application update/delete operation exists for product audit events.
- Existing control-plane audit, organization settings, auth, and tenant
  behavior remain unchanged.

## Validation

- Focused unit tests for safe projection, transactional append, no-op,
  conflict, identical-winner behavior, cursor validation, and bounded paging.
- Backend E2E for event content, authorized listing, negative roles,
  cross-tenant reads, guard-before-pipe behavior, no-op/conflict/concurrency,
  and no arbitrary-body capture.
- Prisma format, validate, generate, migration status, project migration checks,
  and apply-from-current/apply-to-empty database evidence.
- `pnpm agents:check`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm --filter backend test:e2e`
- `pnpm build`
- `ops/tests/documentation.sh`
- `git diff --check`

## Required evidence

- Focused unit and E2E output, including negative tenant/authorization and
  concurrent-writer results.
- Direct database assertions for exactly-once append and safe before/after
  state.
- A forced audit-append failure proving transaction rollback.
- Migration SQL/schema diff and clean migration application evidence.
- Final reviewed diff, commit SHA, PR URL/base/head, and final-head GitHub
  checks.

## Risks and rollback

- JSON projections can become an accidental sensitive-data sink. The writer
  takes a closed state type rather than metadata or a request body, and E2E
  searches a recognizable canary across persisted/API output.
- A transaction changes the timing of the existing optimistic update. Focused
  concurrent E2E preserves both different-writer conflict behavior and
  identical-writer idempotency.
- Audit history grows monotonically. This slice bounds reads and indexes the
  tenant timeline; retention is deferred until product/legal requirements
  exist rather than guessed here.
- Rollback is the ORG-01 image. Its additive profile code ignores the new table;
  the table remains until a separately planned contraction.

## Progress

- [x] Shared discovery and dependency graph
- [x] Design and acceptance contract
- [x] Schema and migration
- [x] Atomic writer and business-profile integration
- [x] Read API and tests
- [x] Documentation
- [x] Focused validation
- [x] Self-review and specialist reviews
- [x] Aggregate validation
- [ ] PR handoff

## Decision log

- 2026-08-27: AUD-01 remains stacked on verified ORG-01 head because its first
  durable action consumes that mutation's service, schema, and E2E contract.
- 2026-08-27: Product audit is a separate organization-owned model; the
  platform-operator control-plane log is not a reusable authorization domain.
- 2026-08-27: The initial vocabulary contains exactly one action and one safe
  state. Future product mutations widen it deliberately in their owning PRs.
- 2026-08-27: `organization:update` authorizes the read surface because the log
  exposes the same settings values; members and non-member global operators
  gain no new tenant visibility.
- 2026-08-27: No Platform screen is included. The bounded authorized API meets
  this foundation's visibility requirement without speculative navigation,
  translation, or pagination UI.
- 2026-08-27: Current Prisma documentation confirms the interactive transaction
  callback/transaction-client contract and PostgreSQL `ReadCommitted` default;
  the existing conditional update remains the lost-update decision point.
- 2026-08-27: Code review traced the mutation, transaction, pagination, schema,
  generated client, migration, and negative tests. It found only unrelated
  Markdown formatting churn introduced by a formatter; that churn was removed
  and documentation checks were rerun successfully.
- 2026-08-27: Security review traced identity, path authorization, tenant
  predicates, validation order, JSON projection, persistence, and response
  paths and found no high-confidence vulnerability. The authenticated actor is
  server-derived, the organization id is guard-checked before query/body pipes,
  Prisma parameterizes every database value, and the only persisted payload is
  the closed business-profile projection verified with a secret-like canary.

## Blockers

None.
