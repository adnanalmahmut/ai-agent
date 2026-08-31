# Resumable managed-secret master-key rotation

## Goal

Deliver SEC-01B as an operator-owned, bounded, resumable, idempotent command
that re-encrypts stored managed secrets to the configured active encryption key
version, without ever overwriting a concurrent credential change and without
disclosing plaintext or key material.

## Context

SEC-01A gave every managed-secret row an explicit `keyVersion`, an active/
decrypt-only keyring, and a legacy compatibility path for pre-version rows
(`keyVersion IS NULL`, resolved by unique fingerprint match, sealed without
AAD). It deliberately did not re-encrypt anything, so a deployment that adds a
new active key accumulates rows that still depend on an older key. Nothing can
retire that old key until those rows are migrated. SEC-01B is that migration.

The repository already has a third composition root for exactly this kind of
work: `apps/backend/src/cli.ts` + `src/cli/` (`CliModule`, `dispatch.ts`,
`super-admin:create`), invoked on a host through
`ops/lightsail/ai-agent-deploy` as `compose run --rm backend node dist/src/cli`.
This work follows that pattern rather than introducing a queue, a worker, or an
HTTP endpoint.

## Scope

- Add a `managed-secret:rotate-key` CLI command: batch-oriented, keyset-paged,
  resumable, idempotent, with `--batch-size` and `--dry-run`.
- Add a `ManagedSecretRotationService` that, per row, decrypts with the exact
  recorded version and re-encrypts under the active version, committing only
  through a compare-and-swap guarded on the row's `updatedAt` and the ciphertext
  it read.
- Record a `managedSecret.reencrypt` audit event per rotated row, and widen the
  closed `managedSecretSlot` audit state with the non-secret `keyVersion` so the
  log shows what actually changed.
- Give the command its own composition root, `RotationCliModule`, with its own
  `rotationConfigurations`. `cliConfigurations` keeps the master key out.
- Document the rollout phases, the exit-code table, and key retirement in the
  operations runbook; correct the pre-keyring description still in
  `docs/configuration.md`.
- Focused unit coverage plus a database-backed e2e over the real
  `RotationCliModule`.

## Non-goals

- Automatic or scheduled rotation, a rotation queue, a background worker, or any
  HTTP/tenant-facing trigger.
- Removing or retiring any configured key. Rotation completion is not
  retirement; retirement stays a later, explicit operator action.
- Removing the SEC-01A legacy null-version compatibility path.
- Generating key material, or any change to the cryptographic primitive.
- Executing rotation against Staging, or changing any real key or GitHub secret.

## Constraints

- Plaintext exists only transiently in process memory between an authenticated
  decrypt and an authenticated encrypt. It is never persisted, never queued,
  never logged, and never placed in an error.
- Never print plaintext, any key material, raw environment values, or ciphertext
  or IV/tag bytes. Output is counts plus code-owned slot identifiers.
- A row is written only after a successful authenticated re-encryption, and only
  if it is still the exact row that was read. A failed row is left byte-for-byte
  intact; there is no partially replaced envelope.
- Unknown recorded versions, missing keys, wrong keys, and tampered rows fail
  closed for that row and never fall back to the active key.
- Rotation must not disturb credential-rotation bookkeeping: `lastRotatedAt` and
  `updatedByUserId` describe an operator entering a new credential value, which
  is not what this does.
- Migration is additive if any schema change proves necessary; a rollback to the
  preceding image must stay possible for the documented window.
- Preserve inherited primary-worktree changes, keep `TODO.md` local, never
  force-push, merge, enable auto-merge, deploy, or operate Staging.

## Design

### Pagination is by primary key, not by the rotation predicate

Rows are read in ascending `key` order — the immutable text primary key — and
each row's disposition is decided in code after reading it.

Paging on "rows whose `keyVersion` is not the active one" would be smaller, but
it makes loop progress depend on a predicate that concurrent writes mutate: a
row that changes under the reader can move into or out of the predicate between
pages and be silently skipped. Ordering on an immutable unique column cannot
reorder or lose a row no matter what else changes, which is the property that
makes an interrupted run safe to resume by simply starting again. This mirrors
the reasoning already recorded in `knowledge-embedding.handler.ts`.

### Compare-and-swap on the row that was read

Per row: read `(key, ciphertext, iv, authTag, algorithm, keyFingerprint,
keyVersion, updatedAt)`, decrypt, re-encrypt, then

```
updateMany({
  where: { key, updatedAt: <the value read>, ciphertext: <the bytes read> },
  data: sealed,
})
```

and require `count === 1`. A concurrent `ManagedSecretService.set` bumps
`updatedAt`, so the guard fails, the update matches nothing, and the operator's
newer credential is preserved rather than overwritten by a re-encryption of the
value it replaced. This is the `updateMany` + count-check pattern the repository
already uses for `AgentRun`, the outbox, and installation pointer swaps.

`updatedAt` is `@updatedAt`, so it is both the token read and the token
advanced — which is correct: the row genuinely changed.

The ciphertext is in the predicate as well, because `updatedAt` alone is not an
exact identity. Prisma computes `@updatedAt` in JavaScript against a
`timestamp(3)` column, so two writes to one row inside the same millisecond
compare equal and the guard would match a row it must refuse. The bytes being
replaced are the honest subject of the comparison and carry no clock dependency
at all.

### Idempotence and resumption

A row already at the active version is a no-op: it is counted and not written.
Therefore a completed run re-run writes nothing; an interrupted run resumed
re-reads from the start and rewrites nothing it already did; and a partially
completed batch leaves every row either fully old or fully new, never in between.

It is still authenticated first, and deliberately. See below.

### Every disposition is backed by a decryption

The sweep opens every row it examines, including the rows it will not write, and
including on `--dry-run`.

The alternative — deciding "already current" from the `keyVersion` column and the
key fingerprint beside it — is cheaper and wrong. Both of those describe the
*key*, not the bytes, so neither can see a ciphertext that has been altered. A
corrupted active-version row would be counted toward "nothing left to rotate",
and the runbook's step D reads exactly that count before authorizing the
permanent deletion of the old key. The one cheap check would sit precisely where
the expensive guarantee is needed.

The cost is one AES-GCM open per row per sweep over a code-owned registry of a
handful of slots. `--dry-run` performs the same authentication and still writes
nothing, which is what makes it a gate rather than a guess.

The exception is a row whose key is not in this build's registry. Authenticated
data is derived from the slot name, so such a row can be neither verified nor
re-sealed; it is reported as `unknownSlot` and left alone, and it is the only
disposition not backed by a decryption.

### Failure isolation

A row that cannot be decrypted (unknown version, missing key, wrong key,
tampered ciphertext, IV, or tag) is counted as unreadable and left untouched, and
the sweep continues. The command exits non-zero so an operator cannot mistake a
partial result for completion — and on a dry run, rows that merely *would* rotate
count as outstanding too, because a dry run's exit code is read as permission to
retire a key.

## Acceptance criteria

- An all-old-version dataset rotates fully; a mixed dataset rotates only what
  needs it; an already-active dataset and an empty table are clean no-ops.
- Rotation is exact-version: a legacy null-version row is decrypted through the
  fingerprint path and re-emerges versioned and AAD-bound.
- A row modified concurrently is never overwritten; the CAS loses safely and is
  reported.
- A failing row leaves its stored bytes unchanged and does not stop the sweep.
- Batch boundaries and multi-batch pagination cover every row exactly once.
- No plaintext canary appears in stdout, stderr, thrown errors, or audit rows.
- `--dry-run` writes nothing and reports the same dispositions.
- Aggregate validation is green and the operator documentation matches.

## Validation

```sh
pnpm --filter backend test -- managed-secret dispatch encryption.config
pnpm --filter backend typecheck && pnpm --filter backend lint
pnpm --filter backend test:e2e
pnpm agents:check && pnpm typecheck && pnpm lint && pnpm test && pnpm build
ops/tests/documentation.sh && ops/tests/lightsail-boundary.sh
git diff --check
```

`jq` must be on `PATH` for `ops/tests/container-environment.sh` to actually run
rather than exit 1; it is absent from the development machine used here.

## Required evidence

- Rotation of all-old, mixed, already-active, and empty datasets.
- Interrupted-then-resumed run, and a re-run of a completed rotation.
- Concurrent-modification CAS loss with the newer value preserved.
- Failed decrypt leaving the row byte-identical.
- Canary absence across stdout, stderr, errors, and audit payloads.
- Independent correctness, test, and security reviews with remediation.
- Final diff, commit, PR URL/base/head, and exact final-head CI.

## Git / PR policy

- Head `feat/managed-secret-master-key-rotation`, stacked on the exact SEC-01A
  final head `a773e10f9998dd1362b9dcc720800fbe23420a39`.
- Open against `feat/managed-secret-keyring`, never against `main`.
- Leave open for human review. No merge, no auto-merge, no force-push. This is
  the fourth and final PR of the train; there is no fifth.

## Risks and rollback

- An operator could run rotation before the new key is configured as active. The
  keyring refuses unknown versions at resolution and the config layer refuses
  malformed or duplicate key material at boot, so the failure is a refusal
  rather than an unreadable row.
- Rotation could be mistaken for permission to drop the old key. The runbook
  states the phases explicitly and the command never removes a key; a row
  rotated to the active version still needs the old key configured until every
  row is confirmed migrated and the rollback window has passed.
- A rollback past the *version-aware* image (SEC-01A) after rotation leaves every
  rewritten row unreadable, and no key configuration fixes it: that image passes
  no authenticated data to the cipher, so it cannot open an AAD-bound envelope
  whichever key it holds. This hazard begins at SEC-01A, not here — the moment
  that image saves any credential, that row is already beyond the previous
  image's reach — but rotation is what applies it to the whole table at once. The
  runbook states it at step A, where the window actually closes, rather than at
  step E where it was previously and incorrectly attributed to key retention.
- Retaining the old key protects a *data* rollback, not an application rollback.
  A table restored from a backup predating the sweep comes back full of
  old-version rows; the rows the sweep rewrote need the new key and always will.
  The runbook ties the retention window to backup restorability for that reason.
- Rotation closes a pre-existing cross-slot exposure, and until it runs that
  exposure stays open. A legacy `keyVersion IS NULL` row is sealed without
  authenticated data, so its envelope is not bound to the slot that holds it:
  anyone able to write the table could move one slot's legacy ciphertext into
  another slot and have it decrypt there, serving credential A wherever B was
  expected. A versioned row cannot be moved that way, because its AAD names its
  slot. Migrating the legacy rows is therefore a security improvement and not
  only a key-management one — which is also why rotation must never seal a row
  back into the legacy shape.

## Decision log

- 2026-08-30: A synchronous CLI, not a queue or worker. The repository already
  has an operator CLI composition root, the work is bounded and operator-timed,
  and a queue would put credential-bearing work into Redis for no benefit.
- 2026-08-30: Page by immutable primary key rather than by the rotation
  predicate, so concurrent writes cannot cause a skipped row.
- 2026-08-30: CAS on `updatedAt` rather than adding a version column, because it
  already exists, already advances on every write, and needs no migration.
- 2026-08-30: `encryptionConfig` joins `cliConfigurations`. **Reversed the same
  day.** An existing test in `composition.config.spec.ts` documents that the
  bootstrap CLI must not require the master key, with the security rationale that
  the command reads no managed secret and so should not hold the key that
  decrypts every provider credential. That test is right and the shortcut was
  wrong. The command now has a fourth composition root, `RotationCliModule`, and
  its own `rotationConfigurations`: rotation gets the keyring and the database and
  no authentication stack, bootstrap gets the authentication stack and no key, and
  only the invoked command is ever constructed. The test was strengthened in both
  directions rather than merely satisfied.
- 2026-08-30: Rotation leaves `lastRotatedAt` and `updatedByUserId` untouched —
  they describe a credential change, and re-encryption is not one.
- 2026-08-31: The CAS predicate includes the ciphertext, not `updatedAt` alone.
  Prisma stamps `@updatedAt` in JavaScript against `timestamp(3)`, so the
  timestamp is a millisecond discriminator rather than an identity; the bytes
  being replaced carry no such dependency.
- 2026-08-31: Every examined row is authenticated, including already-active rows
  and including on `--dry-run`. Metadata describes the key, not the bytes, so a
  metadata-only "already current" would count a corrupted row toward the
  retirement gate. Reviewed and accepted the cost: one AES-GCM open per row per
  sweep over a handful of registry slots.
- 2026-08-31: The registry check precedes the version check, so a row for a slot
  this build does not define reports `unknownSlot` even when it looks current.
  `alreadyActive` asserts the row was opened, and for such a row nothing can open
  it; reporting it as current would be claiming something unverified. The runbook
  documents the remedy.
- 2026-08-31: A dry run counts `wouldRotate` as outstanding for exit-code
  purposes. Exit 0 from a dry run is what the runbook reads as permission to
  retire a key, so it has to mean "the table is current", not "this invocation hit
  no errors".
- 2026-08-31: A `close()` failure during CLI teardown no longer replaces the
  command's exit code. A completed rotation reporting failure because Prisma
  could not drain would send an operator back through a rollout that had in fact
  finished, and that code is the retirement gate.
- 2026-08-31: The rotation verb changes `ops/lightsail/ai-agent-deploy`, an
  installed host bundle file, so `VERSION` moves 4 -> 5. `MIN_VERSION` stays at
  4. Nothing in a deployment calls the verb and the dispatcher's forced-command
  grammar excludes it, so a bundle-4 host deploys a bundle-5 release correctly
  with its own wrapper. Raising the minimum would refuse a currently correct
  host over an optional operator capability. This is the retention precedent,
  not the keyring one, where the minimum had to move because the release could
  not boot without the newer Compose mapping.
- 2026-08-31: A sweep that examined nothing no longer exits 0. Exit 0 is the
  runbook's retirement gate, and an empty result cannot distinguish a current
  table from a command pointed at the wrong database — which the runbook made
  reachable by printing a local `pnpm cli` invocation beside the procedure. The
  invocation is now marked development-only and the exit code refuses.
- 2026-08-31: `ops/host-bundle/CONTENTS` records a digest per bundle version.
  Two changes in this train edited a listed bundle file without moving VERSION
  and no test noticed, because the existing doc coupling only runs in the
  bump-implies-docs direction. Starts at 5; earlier bundles cannot be recovered.
- 2026-08-31: Rollout is two stages by design — the release deploys normally,
  and the operator installs bundle 5 as a separate act. Until then the verb
  exits `unsupported operation`. Rotation itself remains gated on a further
  human decision after that; no deployment step invokes it.

## Progress

- [x] Base, CLI/composition conventions, CAS and pagination precedents, audit
      contract, and operator documentation structure inspected.
- [x] Rotation service, CLI command, dispatch, and composition wiring complete.
- [x] Focused unit and database-backed e2e coverage green.
- [x] Operator documentation and configuration drift corrected.
- [x] Host bundle 5 declared with `MIN_VERSION` held at 4, the two-stage
      operator rollout documented, and the deploy-key exclusion asserted for
      every wrapper verb rather than only the two named ones.
- [x] Independent correctness, test, security, and operational/release reviews
      complete and findings remediated.
- [x] Aggregate validation green.
- [ ] PR open against SEC-01A with final-head CI green at human handoff.

## Blockers

None.
