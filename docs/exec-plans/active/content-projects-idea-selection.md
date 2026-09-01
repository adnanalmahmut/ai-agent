# Content projects, idea selection, and the initial draft target

## Goal

Deliver CNT-01A as the first content slice: a member selects one idea from a
succeeded `content-idea` run and the server persists a `ContentProject` holding
a server-derived snapshot of exactly that idea, together with `ContentDraft`
revision 1 created in the same transaction.

## Context

`content-idea` is the first production agent. `ContentIdeaService` accepts a
request, `AgentRunService` commits the run and its outbox intent in one
transaction under a durable `(organizationId, idempotencyKey)` constraint, and
the worker writes `AgentRun.output` as `{ ideas: [...], sources: [...] }`
validated against `contentIdeaOutput`.

That output is where the product currently stops. An organization can generate
ideas and read them back, but nothing can be *chosen* — there is no durable
object representing "we are doing this one", and therefore nothing for a future
Writer Agent to target. CNT-01A adds exactly that object and nothing else.

The idea snapshot is derived by the server from the pinned run output at a
caller-supplied index. The caller never submits idea prose: accepting a client
copy would let a member persist text the agent never produced while it still
looked agent-authored, and would make the snapshot unfalsifiable against the
run it claims to come from.

## Scope

- Add `ContentProject` and `ContentDraft` in one additive migration, plus the
  `@@unique([id, organizationId])` on `AgentRun` that a tenant-safe composite
  foreign key to the source run requires. Regenerate the committed Prisma
  client.
- Persist a server-derived snapshot of one selected `content-idea@1` idea:
  title, hook, angle, summary, and suggested format, with the content language
  taken from the run input.
- Create `ContentDraft` revision 1 atomically with the project as the initial
  draft target. It carries the target format, language, and title; its body is
  null because no writer exists yet.
- Add `POST /organizations/:organizationId/content-projects/from-idea` using the
  established request-idempotency mechanism: a required `Idempotency-Key`
  header composed with a digest of the request, a durable
  `(organizationId, idempotencyKey)` unique constraint, and read-then-insert
  inside one transaction with a P2002 re-read.
- Add bounded organization-scoped list and detail reads.
- Reference the source run through the composite key `(sourceRunId,
  organizationId)` so PostgreSQL refuses a cross-organization selection.
- Extend the organization permission catalog by the minimum: a single
  `contentProject: ['create', 'read']` statement, granted on the same reasoning
  that splits `contentIdea`.
- Platform: an idea-card selection action on the existing content-ideas block, a
  Projects list, a Project detail view, and complete `ar`/`en` localization.
- Synchronize the owning documentation.

## Non-goals

- Any Writer Agent, draft generation, or draft body mutation. Revision 1 is a
  target, not content.
- A manual create-direct flow that accepts caller-authored idea prose.
- Draft revision 2+, revision history UI, project lifecycle/status transitions,
  scheduling, publishing, or approval.
- Generic content infrastructure: no content-type registry, no pluggable
  pipeline, no abstraction over "artifact".
- Usage metering, cost aggregation, or billing.

## Constraints

- PostgreSQL is authoritative. The cross-tenant refusal is a database
  constraint, not a service-layer check; the service check exists to return a
  clean refusal, not to be the boundary.
- The snapshot is derived server-side from `AgentRun.output` only.
- Selection is valid only against a `SUCCEEDED` run produced by
  `content-idea`. A run belonging to another organization, produced by another
  agent, or not yet terminal is indistinguishable from absent to the caller.
- Reads are organization-scoped and bounded; no unbounded list.
- Client permission gates are UX. The backend guard is decisive.
- No secret, credential, raw provider response, or request-body dumping in any
  persisted row or audit payload.
- Migration is additive and forward-only, and preserves rollback compatibility:
  the preceding image ignores both new tables.

## Acceptance criteria

1. `ContentProject` persists a server-derived snapshot of a selected
   `content-idea@1` idea.
2. `ContentDraft` revision 1 is created atomically with the project; neither can
   exist without the other.
3. `POST .../content-projects/from-idea` is idempotent under a repeated
   `Idempotency-Key`, and the same key with a different body is a different
   request.
4. Organization-scoped list and detail reads are bounded and authorized.
5. A cross-organization `sourceRun` selection is refused by PostgreSQL, proven
   by a test that attempts the insert directly.
6. Exactly one new permission statement is added.
7. Platform provides idea-card selection, Projects list, Project detail, and
   full `ar`/`en` localization with no untranslated string.
8. No Writer Agent, no create-direct flow, no generic infrastructure.
9. The full per-PR completion contract in `TODO.md` is satisfied.

## Validation

- `pnpm --filter backend test` for focused unit coverage.
- `pnpm --filter backend test:e2e` including a negative cross-tenant case.
- `pnpm --filter platform test` for selection, list, and detail behavior.
- Prisma validate, generate, and apply-from-zero with a zero-drift check.
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
  and `ops/tests/documentation.sh` before handoff.
- `git diff --check` clean.

## Required evidence

- Migration applies to a fresh database with zero drift.
- A test proves the cross-tenant source-run insert is refused by the database.
- Idempotency replay and body-mismatch cases are covered.
- test-engineer, security-reviewer, and code-reviewer completed, with
  legitimate findings remediated and focused verification rerun.
- Final-head CI green on the opened PR.

## Decision log

- 2026-09-01 — The snapshot is server-derived from the pinned run output at a
  caller-supplied index. The caller submits an index, never prose.
- 2026-09-01 — Tenant safety for `sourceRun` is a composite foreign key against
  a new `AgentRun @@unique([id, organizationId])`, matching the established
  `KnowledgeSpace`/`OrganizationAgentInstallation` pattern rather than
  introducing a new one.
- 2026-09-01 — `ContentDraft.body` is nullable and stays null in this slice. A
  seeded body would be content nobody wrote.
- 2026-09-01 — One permission statement (`contentProject`), split
  `create`/`read` on the same reasoning as `contentIdea`: creation is the action
  with durable consequence, reading is ordinary membership.

## Progress

- [x] Discovery complete; approved scope re-derived from repository evidence
- [x] Execution plan committed before implementation
- [ ] Schema, migration, generated client
- [ ] Backend domain, service, controller, permissions
- [ ] Focused backend unit and E2E coverage
- [ ] Platform selection, list, detail, ar/en localization
- [ ] Documentation synchronized
- [ ] Specialist reviews and remediation
- [ ] Aggregate validation
- [ ] PR opened, final-head CI green

## Blockers

None.

## History

A prior attempt at this task was lost before anything was committed: its
worktree lived under `/tmp` and was destroyed by a host reboot on 2026-09-01
with no commit, stage, or stash behind it. This attempt commits the plan first
and commits each coherent checkpoint thereafter.
