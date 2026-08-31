# Versioned managed-secret encryption keyring

## Goal

Deliver SEC-01A as the smallest migration-safe multi-key encryption slice: new
managed-secret writes use one explicitly configured active key version, reads
resolve the exact recorded version, and pre-version ciphertext remains readable
only through an explicit fingerprint-matched compatibility path.

## Context

Managed secrets currently use AES-256-GCM with a fresh 12-byte nonce, a full
16-byte authentication tag, and a non-secret double-SHA-256 key fingerprint.
The API and worker both receive one bootstrap `APP_ENCRYPTION_KEY`; changing it
makes every row unusable. PostgreSQL stores the ciphertext, nonce, tag,
algorithm, and fingerprint, but no durable key-version identity. SEC-01A must
make multiple decrypt keys safe before SEC-01B can rotate rows in batches.

## Scope

- Add nullable `keyVersion` metadata to `ManagedSecret` through one additive
  migration and regenerate the committed Prisma client.
- Extend bootstrap configuration with one required active version and an
  optional bounded decrypt-only key list. Retain `APP_ENCRYPTION_KEY` as the
  active key material so the existing protected runtime-material boundary does
  not move.
- Reject malformed versions, malformed keys, duplicate versions, reuse of key
  material across versions, and listing the active version as decrypt-only at
  boot without echoing any submitted material.
- Introduce an injectable managed-secret keyring that seals with the active
  version and resolves only an explicitly recorded version for versioned rows.
- Bind new ciphertext to its managed-secret slot and key version with GCM AAD.
  The version column therefore also selects the AAD-bearing ciphertext format.
- Preserve pre-version rows through one explicit compatibility path: resolve a
  unique configured key by the existing fingerprint, then authenticate without
  AAD exactly as the preceding image wrote the row. Never fall back from a
  non-null unknown version to an active or fingerprint-matched key.
- Make metadata/status reads report the stored version and usability without
  fetching or exposing ciphertext or key material.
- Update API/worker composition, environment allowlists, host preflight,
  synthetic test configuration, operator documentation, and focused unit/E2E
  coverage.

## Non-goals

- Bulk re-encryption, batching, resume checkpoints, rotation CLI/status, CAS
  updates, or key retirement; those belong to SEC-01B.
- Any tenant or product endpoint that returns plaintext or triggers bulk work.
- A generic vault, KMS abstraction, envelope-encryption framework, arbitrary
  algorithm registry, automatic key generation, or database-stored key
  material.
- Changing real Staging configuration, deploying, rotating live ciphertext, or
  removing an old key.

## Constraints

- Key material remains only in root-owned runtime configuration and process
  memory. It never enters PostgreSQL, Redis, audit payloads, API responses,
  frontend state, exception messages, or logs.
- `APP_ENCRYPTION_KEY` is exactly one active AES-256 key.
  `APP_ENCRYPTION_ACTIVE_KEY_VERSION` names it. Optional
  `APP_ENCRYPTION_DECRYPT_KEYS` is a comma-separated `version=base64` list of
  decrypt-only keys; it is never an alternative active-key source.
- Version identifiers use a bounded lowercase application grammar. Every
  configured version and key value is unique.
- Explicit `keyVersion` always wins: unknown/missing configured versions fail
  closed before decryption, with no fingerprint or active-key fallback.
- A null version is accepted only as a preceding-image row. Its existing
  fingerprint must uniquely match one configured key; otherwise it fails
  closed. New writes never store null.
- AES-256-GCM retains fresh random 12-byte nonces and full 16-byte tags. New
  writes authenticate deterministic application-owned AAD derived from the
  registry slot and recorded version; legacy null-version rows use no AAD.
- The migration is additive and rollback-aware. The preceding image ignores the
  new nullable column and can continue writing nulls during the rollout window.
- Preserve inherited primary-worktree modifications and keep `TODO.md` local.
  Never force-push, merge, enable auto-merge, deploy, or operate Staging.

## Acceptance criteria

- Every new or replaced secret records the configured active version and opens
  only with that exact version's key.
- Old-version and active-version rows work simultaneously while both keys are
  configured; active-key writes never select a decrypt-only key.
- Unknown explicit versions, wrong configured keys, altered version/slot,
  malformed nonce/tag, and tampered ciphertext all fail closed without a
  plaintext, provider call, or sensitive diagnostic.
- Pre-version rows remain readable when their fingerprint uniquely matches a
  configured key, including an old decrypt-only key, and fail closed otherwise.
- List/write responses expose only non-secret metadata, including stored key
  version; cross-tenant and super-admin managed-secret boundaries remain
  unchanged.
- API and worker boot validation enforce the same keyring. Migration composition
  still receives no managed-secret key material.
- No automatic bulk re-encryption occurs in this PR.

## Validation

Focused iteration:

```sh
pnpm --filter backend test -- encryption.config secret-cipher managed-secret.service runtime-config.resolver worker-composition
pnpm --filter backend typecheck
pnpm --filter backend lint
ops/tests/runtime-preflight.sh
ops/tests/container-environment.sh
```

Migration and persisted behavior:

```sh
cd apps/backend && pnpm exec prisma format
pnpm --filter backend prisma:validate
pnpm --filter backend prisma:generate
git diff --exit-code -- apps/backend/src/generated/prisma
pnpm --filter backend db:deploy
pnpm --filter backend test:e2e
```

Aggregate:

```sh
pnpm agents:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
ops/tests/documentation.sh
git diff --check
```

## Required evidence

- Active-version writes, old-version reads, mixed-version reads, explicit
  unknown/wrong-version refusal, tamper refusal, and pre-version compatibility.
- AAD binding probes for slot and version changes; no active-key fallback.
- Serialized response, exception, audit, and captured-log canary checks.
- Existing authorization and managed-secret E2E, including direct PostgreSQL
  inspection of versioned ciphertext.
- Config/preflight refusal cases without submitted material in diagnostics.
- Prisma format/validate/generate currentness, apply-from-zero, status/drift,
  and additive SQL evidence.
- Independent code, test, and security reviews with remediation and reruns.
- Final diff, commit, PR URL/base/head, and exact final-head GitHub CI.

## Git / PR policy

- Head `feat/managed-secret-keyring`, exact independent base `main` at
  `4deea359a999a3452f255beab31afb90e36bffe1`.
- Stage only reviewed SEC-01A paths, push normally, and open one sibling PR
  against `main`. Leave it open for human review.
- SEC-01B may start only after this PR's exact final-head CI is green and must
  stack on this feature branch.

## Risks and rollback

- An operator could mislabel key material. Boot validation rejects duplicate
  versions/material and new rows authenticate their version in AAD; a wrong key
  fails GCM authentication rather than yielding plaintext.
- The new version column could become a fallback hint. The keyring treats a
  non-null value as exact authority; only null enters the fingerprint-based
  legacy path.
- The preceding image does not know AAD or key versions. It remains able to read
  its null-version rows and write more of them; it cannot read new versioned
  rows, so the rollout must retain the preceding active key and respect the
  documented rollback window before any rotation. SEC-01B owns the later
  re-encryption and retirement phases.
- Exposing key version metadata could accidentally widen the secret surface.
  The value is a bounded non-secret identifier; ciphertext, fingerprints, key
  material, and plaintext remain absent by explicit selects and response types.
- The first deployment could half-apply. `APP_ENCRYPTION_ACTIVE_KEY_VERSION` is
  required with no default, and the Compose allowlist — not `env_file` — is what
  hands it to a container, so a host still on bundle 3 would migrate and then
  fail to boot. Raising the host bundle to 4 and `MIN_VERSION` with it converts
  that into a refusal ahead of `compose run --rm migrate`.

## Decision log

- 2026-08-27: Keep `APP_ENCRYPTION_KEY` as the sole active material and add an
  explicit active version plus decrypt-only list. This fits the current
  root-owned runtime file and Compose allowlist without inventing a vault.
- 2026-08-27: Null `keyVersion` means only preceding-image ciphertext and is
  resolved by the already persisted fingerprint. Explicit versions never use
  that compatibility path.
- 2026-08-27: New versioned rows use GCM AAD binding the registry slot and key
  version. The version column provides the unambiguous format discriminator;
  legacy null rows retain their prior no-AAD behavior.
- 2026-08-27: Current Node 24 documentation confirms AAD must be set before
  cipher/decipher update, the GCM tag is set explicitly, and authentication
  failure is raised by `final()`. Current Prisma 7 documentation confirms
  migrations and client generation are separate explicit steps.
- 2026-08-31: The change edits two installed host bundle files
  (`docker-compose.yml`, `ops/runtime-preflight.sh`), so `VERSION` moves 3 -> 4.
  `MIN_VERSION` moves 2 -> 4 as well, which is the unusual case: the release
  genuinely cannot run on bundle 3, because that bundle's Compose allowlist has
  no mapping for the boot-required active key version and the file deliberately
  never uses `env_file`. This is the opposite of the retention rollout, where
  the capability was host-side and `MIN_VERSION` stayed behind `VERSION`.
- 2026-08-31: The rollout assigns a version identity to the existing key rather
  than replacing it. `APP_ENCRYPTION_KEY` bytes are unchanged,
  `APP_ENCRYPTION_DECRYPT_KEYS` stays empty, and existing null-version rows keep
  resolving by fingerprint. No bulk re-encryption is performed or scheduled;
  SEC-01B owns rotation.

## Progress

- [x] Independent base, current cipher/schema/config/composition, operator
  deployment model, tests, and documentation inspected.
- [x] Current Prisma 7 and Node 24 crypto documentation checked through Context7.
- [x] Minimal versioned-keyring, AAD, and legacy compatibility design recorded.
- [x] Additive schema/migration and generated client complete.
- [x] Keyring/config/service/composition and operator preflight complete.
- [x] Focused unit/E2E and migration contract green (backend unit 1142/1142,
  backend e2e 597/597, prisma format/validate/generate/migrate deploy).
- [ ] Independent code, test, and security reviews complete and findings remediated.
- [x] Aggregate validation green (typecheck, lint, test repo-wide, build,
  ops/tests/documentation.sh, agents:check, git diff --check).
- [x] Host bundle 4 declared, `MIN_VERSION` raised to 4, and the operator
  prerequisite for the first version-aware release documented in the runbook.
- [ ] PR open with final-head CI green at human handoff.

## Blockers

None.
