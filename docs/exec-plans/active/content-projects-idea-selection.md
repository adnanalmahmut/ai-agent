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
- Persist the originating brief — topic, goal, and the optional audience and
  guidance — snapshotted from `AgentRun.input` by the same parse, and expose it
  on project detail. **Required scope correction, 2026-09-01.**
- Append one closed `contentProject.created` organization product-audit event in
  the same transaction as the project and its draft. **Required scope
  correction, 2026-09-01.**
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
9. The brief is snapshotted server-side from the authoritative run input, never
   accepted from the browser, and surfaced on project detail.
10. A successful promotion appends exactly one audit event; a replay appends
    none; a refused creation appends none; and an audit append that fails rolls
    the project and its draft back.
11. The full per-PR completion contract in `TODO.md` is satisfied.

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

## Required scope corrections

Both were identified in human review of PR #57 on 2026-09-01, after the original
scope had been delivered and reviewed. They are recorded here as corrections
rather than folded silently into the scope above, because the first changes a
behaviour this plan previously documented as deliberate.

1. **The originating brief must live on the project.** The Writer Agent that
   will fill revision 1 is specified to consume `ContentProject` + the selected
   idea + Knowledge, and must not depend on `AgentRun.input` for its brief. The
   original slice left topic and goal reachable only through the run.

2. **A successful promotion must appear in the organization product audit.**
   Promoting is a durable tenant decision, and the audit domain existed already;
   omitting it left the one action that commits an organization to work absent
   from the history other mutations are recorded in.

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
- 2026-09-01 — Promotion is deliberately **not** gated on `agents.enabled` or a
  new `content_projects.enabled` flag, though a review proposed one. Those
  switches stop the platform spending money on a provider. Promoting spends
  nothing: it reads a run the organization has already paid for and records a
  decision about it. `ContentIdeaService.operation` already settles the
  principle for reads — "turning content ideas off stops new requests; it does
  not retract answers an organization already has" — and freezing a team's
  ability to act on results in hand is the same retraction by another route.
- 2026-09-01 — **Reversed:** a run whose `AgentRun.input` cannot be parsed is
  now refused with `CONFLICT source_run_input` rather than promoted with the
  content language defaulted. The earlier reasoning — that the language was not
  load-bearing, so a historical run should stay selectable — no longer holds now
  that the brief comes from the same parse. A project carrying no topic and no
  goal would push the `AgentRun.input` dependency straight back onto the Writer
  Agent, which is the dependency the brief snapshot exists to remove. The
  `contentLanguage` fallback is gone with it; both halves come from one parse.
- 2026-09-01 — The audit projection carries identifiers and the two code-owned
  enums only: project id, source run id, selected idea index, suggested format,
  content language, and draft revision. It deliberately excludes the caller's
  `Idempotency-Key`, the request body, the brief, and the agent's generated
  prose. The brief is operator-authored free text and the idea prose is
  model-generated; neither adds anything an identifier does not, and the audit
  contract promises no generic metadata. `before` is null because a creation has
  no prior state.
- 2026-09-01 — The brief is exposed on project *detail* only, not on the list.
  A backlog screen shows what was decided, not the paragraph behind each
  decision, and four more text columns on every row of every page would make
  the list heavier for something nothing on it renders.
- 2026-09-01 — The promotion idempotency key is derived from
  `(sourceRunId, ideaIndex)` and is therefore guessable by anyone who can read
  the run, and is not scoped to the member. A review noted an organization
  admin could pre-create a project and take attribution for a decision. Accepted:
  a random key would break the double-click and reload deduplication the derived
  key exists for, the actor already holds `contentProject:create`, and the prose
  is server-derived so nothing can be forged. Both properties are pinned by
  tests so changing either is deliberate.

## Progress

- [x] Discovery complete; approved scope re-derived from repository evidence
- [x] Execution plan committed before implementation
- [x] Schema, migration, generated client — applies from zero, zero drift
- [x] Backend domain, service, controller, permissions
- [x] Focused backend unit and E2E coverage — 18 E2E cases green
- [x] Platform selection, list, detail, ar/en localization — 13 cases green
- [x] Documentation synchronized
- [x] Specialist reviews and remediation
- [x] Aggregate validation
- [x] PR #57 opened, final-head CI green on `32871c3`
- [x] Required scope corrections: brief snapshot and product audit
- [x] Specialist re-review and aggregate re-validation after the corrections
- [ ] Final-head CI green on the corrected head

## Blockers

None.

## Review outcomes

Three specialist reviews ran against `ab551bc`. Findings remediated:

- The response projection returned the stored `idempotencyKey`, which embeds the
  caller's own header. Confirmed on the wire before fixing. Both reads and the
  create now use explicit `select`, and an e2e case pins the whole field set.
- The Platform promote button was gated on `contentIdea:create` rather than
  `contentProject:create`, which silently defeated the split the new statement
  exists for. The test written to cover it passed for the wrong reason; it now
  discriminates.
- Promote state was not scoped to the operation, so a second generation showed
  the previous run's project on the card at the same index and hid the new
  run's button.
- A failed "load more" set a terminal error, and its retry restarted from page
  one and discarded every accumulated page.
- The detail route's comment claimed it was keyed on organization and project;
  it was keyed on one. Now keyed on both.
- `INVITATION_ROUTE` lost its contract comment to an insertion; restored.
- The language fallback said "organization-wide default" and returned a literal;
  it now imports `DEFAULT_LOCALE` and says so.
- The replay lookup ran after the run was resolved, so a retry of an already
  succeeded promotion would fail once a definition revision made the run
  unreadable. It now wins first.
- Query validation duplicated the page ceiling, making the service's own bound
  unreachable. The controller validates shape; the service owns the ceiling.
- Pure helpers moved to `content-project-pagination.ts`, matching
  `knowledge-pagination.ts`, so the cursor decoder's six refusal branches and
  the page-size bounds are unit-tested directly.
- Promotion failures were flattened to one sentence; a refusal and an
  unreachable server are now distinguished.

Tests added for: the wrong-agent 404, the unreadable-output 409, the language
fallback on both rows, actor attribution, the concurrent P2002 path,
organization-scoped and member-shared idempotency, the project-without-draft
invariant, cursor drain to exhaustion over a shared timestamp, newest-first
ordering, the `ContentProjects` i18n namespace enumeration, and Arabic renders
of both new screens.

## Re-review outcomes (scope corrections)

All three specialists re-ran against `c26eb2e`. Security found no new exposure
and independently verified that the field-by-field `toView` drops the brief and
the stored key at every call site, that the audit append cannot leave a project
without its event or an event without its project, and — by compiling a probe —
that the discriminated union does not relax TypeScript's excess-property check.

Two reviewers independently found the same defect, and it was real:

**The rollback test proved nothing about the transaction boundary.** The stub
threw without inspecting what it was handed, so the test was satisfied by "the
promotion failed and left no rows". Confirmed by changing the call site to pass
`this.prisma` instead of `tx` — the exact defect the arrangement exists to
prevent, since the event would then commit on its own connection while the
project rolled back — and watching all 40 cases stay green. The stub now
asserts that what it receives is not the injected client and that the project is
already visible inside that transaction, and it fails on the injected defect.

Also remediated:

- The draft no longer had an independent language assertion after the reversal;
  hard-coding it passed. Restored, and the strict-parse refusal now covers all
  three shapes it can take rather than one.
- Three refusals answer 409 and none discriminated its reason; each now does.
- The list-projection closedness was asserted by two named keys; it is now the
  whole key set, matching the detail guard.
- Two audit tests could pass vacuously, because a failed create makes the
  subject lookup match every event in the organization.
- The refusal set omitted the two refusals that throw inside the transaction.
- `draftRevision` used `?? 1`, which would have fabricated a revision for a
  project with no draft — the fabrication `before: DbNull` exists to avoid.
- The audit projection typed its two enums as `string` while its comment claimed
  they could not carry an arbitrary one. They are now typed as the enums, which
  immediately caught the call site reading them back off `String` columns.
- **The migration's stated justification was false.** It claimed the guard
  prevented "a migration that fails halfway with the columns already added".
  PostgreSQL DDL is transactional, so an unguarded populated table would already
  fail cleanly and wholly. The guard buys a legible message naming the row count
  and the missing backfill — nothing more. Corrected in the migration and in
  `docs/database.md`.
- The detail view treated `''` as "the request said something", rendering a
  label with no value. `guidance` is optional with no minimum length, so a
  direct API caller can store one.
- Added: a test pinning that a replay is answered before the run is consulted,
  so a retry still returns its project after the run becomes unreadable.

## Verified evidence

- All migrations apply to a fresh database from zero; `migrate diff` against the
  applied database reports no change attributable to this work. The one
  difference it does report — a truncated index name on
  `organization_audit_event` — reproduces identically on unmodified `main` and
  predates this change.
- PostgreSQL refuses, against a scratch database and again through the E2E
  suite: a project naming another organization's run, a draft filed under
  another organization's project, a duplicate revision within one project, and a
  replayed idempotency key. The two legitimate control inserts succeed.
- `pnpm --filter backend test` 1290 passed; `pnpm --filter platform test` 850
  passed; `apps/web` 26 passed; backend E2E 46 passed for this feature.
- The transaction boundary and the audit rollback are proven by fault injection
  rather than by assertion alone: passing `this.prisma` instead of the
  transaction client fails the suite.
- The migration guard was exercised by seeding a row and observing it refuse
  with the columns not added.
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and
  `ops/tests/documentation.sh` all green without `--fix` in verification.
- Full backend E2E: 627 of 631 passed. The 4 failures are in
  `agent-run-reconciliation.e2e-spec.ts`, a BullMQ stalled-job timing suite, and
  reproduce identically on unmodified `main` in the same environment.

## History

A prior attempt at this task was lost before anything was committed: its
worktree lived under `/tmp` and was destroyed by a host reboot on 2026-09-01
with no commit, stage, or stash behind it. This attempt commits the plan first
and commits each coherent checkpoint thereafter.
