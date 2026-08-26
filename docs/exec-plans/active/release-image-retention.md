# Safe application release-image retention and disk reporting

> Status: design approved with mandatory corrections. Gate 1 (image identity)
> is proven empirically. Delivered as two independently reviewable PRs,
> OPS-03A then OPS-03B, with an operator bundle install between them.
> PR #41 is merged and local `main` is resynchronized at `a05a317`.

## Goal

Make a successful deployment reclaim disk by removing only superseded
application release images, while proving that both rollback targets remain
intact, so the condition that stopped Staging on 2026-08-26 cannot recur.

## Context

This plan exists because of a real incident, not a hypothetical. During the
OPS-01 rollout the Staging host was found at:

- 58G filesystem, 55G used, 2.9G free, 95% used
- 53 images, 52.28 GB of Docker images

The disk gate added by OPS-01 refused the deployment at **2963 MiB free against
the required 4096 MiB**. That refusal was correct and is the reason the problem
surfaced as a clean stop instead of an opaque mid-deployment extraction
failure. The operator then remediated by hand, using a protected digest
allowlist:

- all 8 `CURRENT_RELEASE` and `PREVIOUS_RELEASE` digests verified present
- 40 older application release images removed
- obsolete unused `postgres:16-alpine` and `alpine:latest` also removed
- no live containers, volumes, database data, runtime secrets, or
  current/previous release images removed
- final state 58G filesystem, 16G used, 42G free, about 28% used
- `ai-agent-host-preflight disk 4096` then reported
  `free space 42400MiB satisfies the required 4096MiB`

That manual procedure is the specification. This plan automates it and must not
be weaker than what a careful human did by hand.

## Scope

Rescoped and approved:

- Safe application release-image retention.
- Disk-space reporting (before, after, reclaimed).
- Stronger anti-blanket-reclaim boundary assertions.

## Already delivered, and deliberately untouched

Two items originally listed under OPS-03 are already satisfied by shipped code.
Verified by reading the scripts, not inferred. These are **not** to be rebuilt
or modified unless this plan objectively requires it.

**PostgreSQL backup archive verification — satisfied.**

- `ops/backup/backup-postgres.sh` runs `pg_restore --list` against every dump
  before accepting it, then writes a `.sha256` beside it.
- `ops/backup/verify-backup.sh` re-checks the checksum with
  `sha256sum --check` and re-reads the archive catalogue on demand.
- Asserted by `ops/tests/backup-recovery.sh`.
- Documented in `ops/backup-recovery.md`.

**Isolated non-production restore drill — satisfied.**

- `ops/backup/restore-drill.sh` requires an explicit `isolated-non-production`
  marker, requires the target database name to match `*_restore_drill`,
  resolves target and live identity *through PostgreSQL* rather than comparing
  URL text so an alias cannot point at the live database, refuses any
  non-empty target, and reports the restored public table count as evidence.
- Asserted by `ops/tests/restore-drill-safety.sh`, wired into CI.
- Documented in `ops/backup-recovery.md`.

**Backup retention already exists** — `BACKUP_RETENTION_DAYS`, default 14, with
a `find -mtime -delete` sweep in `ops/backup/backup-postgres.sh`. Unrelated to
image retention and must not be disturbed. It is a useful precedent for style:
a bounded, explicitly-scoped sweep rather than a blanket reclaim.

## Non-goals

- No change to the backup or restore subsystem.
- No removal of containers, volumes, networks, or build cache. Ever.
- No removal of non-application images. `postgres`, `redis`, and `geoipupdate`
  are infrastructure the compose file needs; the fact that the operator also
  removed two obsolete base images by hand does not make that this script's job.
- No retention depth beyond `CURRENT` and `PREVIOUS`.
- No change to the manifest schema or the release digest validation.
- No widening of the forced-command grammar.

## Mandatory design corrections

Five corrections were required after the first design review. Each is recorded
with the reason, because each closes a real hole in what was proposed.

### 1. The bundle version moves in two stages, with no known-red deployment

The retention script becomes an installed bundle file and the wrapper
eventually calls it, so the release does come to depend on a host artifact that
bundle 1 lacks. Declaring that dependency is mandatory. Producing a deliberately
failed Staging deployment to do so is not.

The version therefore moves in two stages:

| | `VERSION` | `MIN_VERSION` | Wrapper calls retention? |
| --- | --- | --- | --- |
| OPS-03A | 2 | **1** | No |
| operator installs bundle 2 | — | — | — |
| OPS-03B | 2 | **2** | Yes |

`MIN_VERSION` stays 1 in OPS-03A for one strict reason: at that stage the
release is *fully functional* on bundle 1. The new file is installed capability
that nothing invokes, so a bundle-1 host is not merely tolerable, it is
completely correct. Declaring a minimum of 2 there would refuse deployments over
a dependency the release does not yet have.

OPS-03B is where the dependency becomes real, and that is where `MIN_VERSION`
becomes 2. By then the operator has installed bundle 2, so the gate passes on
the first attempt and no deployment is sacrificed to make a point.

This supersedes the earlier single-PR plan, which accepted a known-red Staging
deployment as the cost of declaring the contract. The two-stage split reaches
the same end state — enforcement declared, no silent non-activation — without
it. The gate is still doing its job; it simply never has to fire, because the
host is upgraded before the release that requires it exists.

### 2. Protected images are verified present before any mutation

The first design verified the protected digests only *after* the sweep. That is
too late: it would discover a missing rollback image by having already deleted
other things around it. Required order, with no mutation before the last check
in the establish phase:

```
1  read CURRENT_RELEASE.json
2  read PREVIOUS_RELEASE.json
3  strictly validate both records (sha + four digests, well-formed)
4  build the complete protected digest set
5  verify every protected digest is present locally      <- before any mutation
6  if any is absent: remove nothing, fail closed
7  enumerate only the four known application repositories
8  candidates = local application images - protected set
9  remove explicit digest references only, one at a time
10 verify the complete protected set again               <- after mutation
11 report before / after / reclaimed
12 re-run the disk preflight
```

Step 5 is the correction. Step 10 is retained: it catches a removal that
affected something it should not have, which step 5 cannot.

A consequence worth stating plainly: on a host whose rollback images have
already drifted away, retention becomes a loud no-op until a human resolves it.
That is the intended trade. A host that has lost its rollback capability should
not also be having images deleted by an automated sweep.

### 3. An in-use unprotected image is state drift, not expected success

The first design classified "Docker refuses removal because the image is in
use" as normal and tolerable. That was wrong. If an application image outside
`CURRENT` and `PREVIOUS` is still referenced by a running container, then
runtime state and recorded release state disagree, and that is exactly the class
of inconsistency this repository refuses to paper over.

Required behaviour:

- never force removal, under any circumstance
- record the candidate as not reclaimed
- report the inconsistency loudly, naming the image and the container
- the standalone operator command exits non-zero
- a completed, healthy deployment is not failed or rolled back solely because
  retention reported this

Refinement on top of the correction: a *stopped* container also blocks removal,
and that is a different signal from a *running* one. A leftover exited container
is untidy; a running container on an unrecorded release means the host is
serving something the release state does not describe. Both are reported, both
block removal of that candidate, and they are reported distinctly rather than
merged into one message.

### 4. Deployment failure semantics

Retention runs only after a successful deployment and after `CURRENT`/
`PREVIOUS` rotation, so it always reads post-deploy truth.

Retention failure must not turn a healthy completed deployment into a failed
one. The release is already live and passing health checks; failing the job
could provoke a rollback of something that works, which would be a
self-inflicted outage caused by a disk-hygiene step.

It must equally not be swallowed:

- emit an explicit warning or error summary in the deployment output
- state clearly when reclaim was zero or partial, and why
- the standalone operator command keeps a non-zero exit
- the hard safety gate remains the **next** deployment's disk preflight, which
  is the check that caught this in the first place

So the failure is loud but not fatal, and the backstop is a refusal that already
exists and is already proven in production.

### 5. Anti-blanket-reclaim assertions are strengthened

`ops/tests/lightsail-boundary.sh` currently forbids `down -v`,
`volume prune`, and `system prune --volumes`. A bare `system prune`, or
`image prune -a`, would pass today. That gap is closed here, since this is the
first change that has any reason to touch image removal at all.

## Safety invariants

1. A digest recorded in `CURRENT_RELEASE.json` is never a removal target.
2. A digest recorded in `PREVIOUS_RELEASE.json` is never a removal target.
3. A digest appearing in both is protected; set semantics, not first match.
4. Only the four application repositories may yield candidates.
5. Nothing is removed unless the protected set is structurally valid **and**
   fully present locally.
6. No container, volume, network, or build cache is ever removed.
7. No blanket reclaim of any kind: enumerate, subtract, remove explicit digests.
8. Removal is never forced.
9. The protected set is re-verified after the sweep, and its absence is a
   failure requiring operator attention.
10. The forced-command grammar is unchanged, so the CI deploy key cannot invoke
    retention directly.

## Trust boundary

The dispatcher grammar in `ops/lightsail/ai-agent-deploy-dispatch` is **not**
widened. Retention runs inside the wrapper's already-authorised successful
deploy path. Adding a verb such as `reclaim` to the forced command would extend
what a compromised CI deploy key can reach, which is the specific exposure
OPS-01 was built to contain.

A standalone operator subcommand is provided for manual use and, like
`bootstrap-super-admin`, is deliberately unreachable over SSH.
`ops/tests/lightsail-boundary.sh` asserts this by extracting the real allowlist
from the shipped dispatch script, so widening the grammar fails a test rather
than passing beside it.

## Delivery: two independently reviewable PRs

### OPS-03A — Host bundle v2 capability rollout

Ships the capability, activates nothing.

- Add `ops/release-retention.sh`, installed as
  `/usr/local/sbin/ai-agent-release-retention`.
- Add it to `ops/host-bundle/files`; bump `ops/host-bundle/VERSION` to 2;
  **leave `ops/host-bundle/MIN_VERSION` at 1**.
- Do **not** call retention from `ops/lightsail/ai-agent-deploy`.
- Do **not** make any release behaviour depend on bundle 2.
- Strengthen `ops/tests/lightsail-boundary.sh` against a bare system reclaim,
  an `-a` system reclaim, and an `-a` image reclaim. The current forbidden list
  covers only `down -v`, a volume reclaim, and a system reclaim with
  `--volumes`, so all three of those pass today.
- Preserve the dispatcher grammar exactly.
- Add `ops/tests/release-retention.sh` and wire it into CI.
- Add `docs/release-retention.md`; update `docs/host-bundle.md` and
  `ops/lightsail/README.md` for bundle 2.
- No live Staging operation.

The script is fully implemented and fully tested in OPS-03A, including every
refusal path and its mutation probes. Only the *invocation* is withheld. That
puts the risky logic under review before anything can call it, and keeps
OPS-03B a small, readable activation diff.

Because nothing invokes it, a bundle-1 host stays completely correct and the
release keeps deploying normally throughout.

Stop at: PR open, independent review complete, legitimate findings repaired,
final-head CI green, ready for human merge. Do not merge.

**Between the two PRs:** the operator installs bundle 2 on Staging and verifies
it. OPS-03B may not begin until that evidence exists.

### OPS-03B — retention enforcement and activation

- Bump `MIN_VERSION` to 2.
- Wire retention into the successful post-deploy path, after `CURRENT`/
  `PREVIOUS` rotation.
- Preserve non-fatal-to-a-healthy-deployment failure semantics.
- Pre-mutation and post-mutation protected-image verification.
- Explicit digest-only candidate deletion.
- Disk before / after / reclaimed reporting.
- Post-retention disk preflight.
- State-drift reporting distinguishing running from stopped containers.
- All approved safety invariants and their mutation probes.

Prerequisite, not negotiable: verified operator evidence that Staging is running
bundle 2.

## Files

New, in OPS-03A:

- `ops/release-retention.sh` -> `/usr/local/sbin/ai-agent-release-retention`
- `ops/tests/release-retention.sh`
- `docs/release-retention.md`

Modified in OPS-03A:

- `ops/host-bundle/files`, `ops/host-bundle/VERSION` (1 -> 2)
- `ops/tests/lightsail-boundary.sh` — stronger anti-reclaim assertions; assert
  retention is not remotely dispatchable
- `ops/tests/host-bundle.sh` — inventory coverage and version expectations
- `.github/workflows/ci.yml` — run the new test
- `docs/host-bundle.md`, `ops/lightsail/README.md`,
  `ops/container-foundation.md`

Modified in OPS-03B:

- `ops/host-bundle/MIN_VERSION` (1 -> 2)
- `ops/lightsail/ai-agent-deploy` — invoke retention after state rotation; add
  the operator-only subcommand
- `docs/cd.md`, `docs/rollback.md`, `docs/operations-runbook.md`,
  `docs/troubleshooting.md`

## Gate 1: the image identity contract, proven empirically

Run 2026-08-26 against Docker 29.7.2 and the real published immutable images
for three consecutive releases. Not inferred from documentation.

### What the release record holds

`write_release_manifest` stores what CI resolved with
`docker buildx imagetools inspect --format '{{.Manifest.Digest}}'`. For release
`a1836e1` that is
`sha256:ffeadcddb392d8f95a33f707f8656d489fb5962a33977d0c802b8632af5a7367`, and
`docker manifest inspect` shows it is an **OCI image index**
(`application/vnd.oci.image.index.v1+json`) containing two manifests:

- `sha256:2007b35e...` — the `linux/amd64` platform image
- `sha256:7a3c47d4...` — platform `unknown/unknown`, the provenance/SBOM
  attestation that bake attaches

So the recorded digest is emphatically **not** the platform manifest digest.
Any design that compared it against a platform manifest digest would mis-classify
every protected image.

### What a local pull exposes

After `docker pull <repo>@sha256:ffeadcdd...`, which is exactly the reference
compose resolves from `BACKEND_IMAGE`:

| Field | Value |
| --- | --- |
| `RepoDigests` | `[<repo>@sha256:ffeadcdd...]` — the index digest, as pulled |
| `docker image ls --digests` DIGEST | `sha256:ffeadcdd...` |
| `.Id` | `sha256:ffeadcdd...` on this daemon |

Equality holds. `docker image inspect <repo>@sha256:ffeadcdd...` resolves;
inspecting by the platform manifest digest or the attestation digest both fail
with `No such image`, and the attestation never appears as a local image.

### Why `.Id` must not be the contract

On the probed daemon `.Id` equalled the index digest, which is **not** a
universal property: `docker info` reports storage driver `overlayfs` with
`driver-type: io.containerd.snapshotter.v1`, i.e. the containerd image store,
where images are keyed by manifest digest. A daemon using the classic store
reports the config digest as `.Id` instead. The Staging daemon cannot be
inspected from here, and must not be, so the design cannot depend on which store
is in use.

### The contract the implementation must use

**Resolve, never compare digest strings.** The recorded reference is handed to
Docker and whatever identity Docker returns is used for comparison:

1. For each protected entry, run
   `docker image inspect <repo>@sha256:<recorded> --format '{{.Id}}'`.
   Failure to resolve is the pre-mutation refusal, not an absent protected
   image.
2. Enumerate application images and resolve each to its `.Id` the same way.
3. Compare on those resolved `.Id` values.

This is store-agnostic by construction: it never assumes the recorded digest
string equals an enumerated digest string, only that Docker resolves both
consistently on the same daemon. `RepoDigests` is used for reporting and for
building the explicit removal reference.

### Verified on the real retention scenario

Three generations of `backend` pulled simultaneously — `a1836e1` as CURRENT,
`d358076` as PREVIOUS, `785b059` as superseded:

- With only CURRENT and PREVIOUS present: both classified PROTECTED, zero
  candidates. Correct.
- With the superseded generation added: exactly one CANDIDATE, `48f7898d`
  (`785b059`), and both rollback images PROTECTED. Correct.
- Removal by explicit `<repo>@sha256:48f7898d...` reference removed only that
  image; both rollback digests survived, confirmed by re-enumeration.

### Counterexample: a mismatched identity cannot make CURRENT deletable

Required test, and the single most important result of this probe. Feeding the
platform manifest digest `sha256:2007b35e...` where the record should hold the
index digest — a plausible mismatch if CI ever changed its digest source:

- **With the pre-mutation gate:** the reference fails to resolve, retention
  refuses with exit 64 and removes nothing.
- **With the gate removed:** the protected set silently comes back short, and
  the subtraction classifies `ffeadcdd` — the image of the **currently running
  release** — as a CANDIDATE for deletion.

That is the whole justification for correction 2. The pre-mutation presence
check is not defence in depth; it is the single control that turns an identity
mismatch from "delete the running release" into "refuse and change nothing".
Its mutation probe is therefore mandatory, not optional.

### Implementation cautions found while probing

- `docker image rm` exits **1** on an in-use conflict. During the probe a piped
  invocation reported the pipeline's status instead, masking the failure.
  Capture Docker's status directly; never read it through a pipe. This is the
  same class of mistake as the OPS-02 subshell finding.
- The conflict message names the blocking container, and
  `docker ps --all --filter ancestor=<reference> --format '{{.State}}'` resolves
  it programmatically, returning `running` for a live container and `created` or
  `exited` for a leftover. That is what makes correction 3's distinction between
  genuine state drift and an untidy leftover implementable rather than
  aspirational.

**Conclusion: the identity contract is proven. Retention may proceed.**

## Test strategy

Sandbox pattern from `ops/tests/host-bundle.sh`: a fake state directory with
crafted manifests, and a `docker` stub that records every invocation so the test
asserts on what would have been executed.

Required cases, each of which must prove a refusal happens *before* mutation
where that is the point:

- happy path removes exactly the superseded digests and nothing else
- no blanket reclaim is ever emitted: no `system prune`, no `image prune -a`
- no container, volume, or build-cache removal is ever emitted
- only the four application repositories appear as candidates
- `CURRENT` digests are never targeted
- `PREVIOUS` digests are never targeted
- missing `CURRENT_RELEASE.json` refuses before mutation
- malformed `CURRENT_RELEASE.json` refuses before mutation
- missing `PREVIOUS_RELEASE.json` refuses before mutation
- malformed `PREVIOUS_RELEASE.json` refuses before mutation
- a protected digest absent locally refuses before mutation
- a digest shared by `CURRENT` and `PREVIOUS` stays protected
- an in-use unprotected image produces a visible failure, no forced removal,
  and a non-zero standalone exit
- an interrupted sweep cannot have targeted a protected digest
- post-sweep protected verification is mandatory and fails loudly when a
  protected digest has gone
- reclaimed-space reporting is arithmetically correct
- the disk preflight is re-run after retention
- the dispatcher grammar is not widened
- the deploy SSH identity cannot invoke retention

Every refusal path is mutation-probed: remove the guard, confirm the suite
fails; restore it, confirm the suite passes. A refusal no test can make fail is
indistinguishable from no refusal, which is how the OPS-02 coverage gap was
found.

## Validation

- `ops/tests/release-retention.sh`, `ops/tests/host-bundle.sh`,
  `ops/tests/lightsail-boundary.sh`, `ops/tests/deploy-service-health.sh`,
  `ops/tests/release-manifest.sh`, `ops/tests/documentation.sh`
- `pnpm agents:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- Mutation probes for every guard listed above

## Required evidence

Command output for each check, the PR URL, final-head CI with per-job results,
and the mutation-probe results. Staging is not operated as part of this change.

## Rollback and compatibility

The change is revertible as a unit: the retention script, its inventory entry,
the wrapper call, and the version bump. Nothing persistent is created and no
state migrates; `CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json` are read, never
written, by retention.

Each PR is revertible on its own, which is part of why the work is split.
Reverting OPS-03B returns the host to installed-but-idle capability and a
`MIN_VERSION` of 1; reverting OPS-03A as well removes the script. Nothing
persistent is created and no state migrates: retention reads
`CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json` and never writes them.

## Host bundle rollout implications

The whole point of the two-stage split is that **no deployment is ever expected
to fail**. The sequence:

**OPS-03A merges.** Images are labelled
`io.ai-agent.host-bundle.min-version=1`, unchanged. The Staging host is at
bundle 1, `1 -ge 1` holds, and `Deploy staging` succeeds normally. The host does
not yet have the retention script and does not need it, because nothing calls
it. Repository bundle `VERSION` is 2 while the host is at 1, which is exactly
the state the bundle mechanism is designed to express: an available capability
the host has not adopted.

**Operator installs bundle 2.** On the Staging host, from a checkout of the
merged release:

1. `sudo ops/lightsail/install-host-bundle.sh`
2. `sudo ai-agent-host-preflight integrity` reports bundle 2

The installer validates the whole inventory before installing anything, so a
malformed new entry refuses without touching the host. After this the retention
script is present and still uncalled — installed capability, no behaviour
change. Deployments continue to succeed throughout.

**OPS-03B merges, only after that evidence exists.** Images are now labelled
min-version 2. The host is already at bundle 2, so
`ai-agent-host-preflight require-version 2` passes on the first attempt and
retention runs at the end of the deployment.

Two properties worth stating precisely, both verified from the code:

**The gate would still have caught the mistake.** `require-version` is called
from `verify_release_declaration`, which runs after the image pull but before
`compose up`, `require_postgres_extensions`, and `compose run --rm migrate`. Had
OPS-03B merged against a bundle-1 host, it would have refused with exit 64 and
`this release requires host bundle 2 and the host has 1` — after pulling, but
before anything forward-only. The two-stage rollout means that refusal is never
reached, rather than being relied on.

**The gate is self-enforcing, which is what makes the ordering safe rather than
merely tidy.** The check is performed by the wrapper already installed on the
host, and `verify_release_declaration` shipped in bundle 1. So a host that
somehow missed the bundle install still refuses OPS-03B's release instead of
running it without the capability it declares. The ordering is enforced by the
host, not by anyone remembering to do it in the right order.

## Failure modes

| Mode | Behaviour |
| --- | --- |
| `CURRENT` or `PREVIOUS` missing | Remove nothing, report, deployment unaffected |
| `CURRENT` or `PREVIOUS` malformed | Remove nothing, report, deployment unaffected |
| Protected digest absent locally | Remove nothing, fail closed, report loudly |
| First-ever deploy, no `PREVIOUS` | Remove nothing; the full protected set cannot be established |
| Unprotected image used by a running container | State drift: not reclaimed, reported loudly, never forced |
| Unprotected image held by a stopped container | Not reclaimed, reported as a leftover, never forced |
| Digest in both releases | Protected; set semantics |
| Sweep interrupted partway | Protected set was never a target, so worst case is partial reclaim |
| Protected digest missing after sweep | Loud failure requiring operator attention |
| Concurrent deployment | Already prevented by the existing `flock` on `deploy.lock` |
| Retention fails entirely | Deployment stays successful; next deploy's disk preflight is the hard gate |

## Dependencies

- PR #41 is merged; local `main` is resynchronized at `a05a317`. Satisfied.
- OPS-03A is based on `main` at `a05a317`.
- **OPS-03B must not begin until there is verified operator evidence that
  Staging is running host bundle 2.**
- Depends on OPS-01's host bundle mechanism and OPS-02's artifact chain, both
  merged and proven in production.

## Acceptance criteria

- A successful deployment reclaims superseded application release images and
  reports before, after, and reclaimed space.
- No mutation occurs unless the protected set is structurally valid and fully
  present locally.
- Both rollback releases are verifiably intact after every sweep.
- No blanket reclaim exists anywhere in the repository, asserted by test.
- The forced-command grammar is unchanged and retention is not remotely
  invocable.
- Retention failure never fails a healthy completed deployment, and is never
  silent.
- Every refusal path is mutation-probed.
- Aggregate validation and final-head CI are green.

## Progress

- [x] Rescope approved: retention, disk reporting, anti-reclaim assertions.
- [x] Confirmed by reading the shipped scripts that backup archive verification
      and the isolated restore drill are already delivered, with pointers
      recorded above.
- [x] Confirmed no image retention logic exists anywhere in the repository.
- [x] Confirmed the current anti-reclaim assertions miss a bare `system prune`
      and `image prune -a`.
- [x] Verified the version-gate mechanism and its ordering in the wrapper, so
      the rollout consequence of `MIN_VERSION=2` is stated from the code rather
      than assumed.
- [x] Design corrections recorded.
- [x] **Gate 1 passed.** Image identity proven empirically against Docker 29.7.2
      and the real published images for three consecutive releases. The recorded
      digest is an OCI index digest; it resolves locally, the platform and
      attestation manifest digests do not, and the attestation never appears as
      a local image. The contract is *resolve through Docker, never compare
      digest strings*, which keeps it independent of the image store in use.
      Verified on the real three-generation retention scenario: exactly one
      candidate, both rollback images protected, and removal by explicit digest
      reference affecting only the candidate.
- [x] Counterexample proven: with the pre-mutation gate a mismatched identity
      refuses and changes nothing; with the gate removed the running release's
      own image is classified deletable. The gate is the load-bearing control.
- [x] Two-stage rollout adopted so no deployment is ever expected to fail.
- [x] Probe cleanup verified: all three pulled images and both probe containers
      removed; the local daemon is back to its pre-probe image count.
- [x] OPS-03A implemented: `ops/release-retention.sh`,
      `ops/tests/release-retention.sh`, `docs/release-retention.md`, bundle
      `VERSION` 2 with `MIN_VERSION` held at 1, the widened anti-reclaim sweep,
      and no invocation anywhere. `ai-agent-deploy`,
      `ai-agent-deploy-dispatch`, and the sudoers fragment are byte-identical
      to `main`.
- [x] Review findings repaired. Six in total, five of them in the tests:
  1. **Dead probe, medium.** The post-mutation verification probe removed the
     guard and then asserted nothing. It also could not have asserted anything,
     since protected images are never candidates and so no input reaches a sweep
     that loses one. The Docker stub now models collateral damage, which is the
     only way to make that guard fire.
  2. **Dead probe, medium.** The blocking-container probe asserted only that
     some `image rm` appeared in the log, which it does anyway for the unblocked
     candidates. It passed with the guard intact. Now discriminated on the
     blocked reference.
  3. **Overclaim, low.** The digest-format probe asserted the guard was
     load-bearing; it is not. A malformed digest cannot reach a mutation either
     way, because the reference fails to resolve and the pre-mutation gate
     refuses. The probe now documents the layering instead of overstating it.
  4. **Untested guard, low.** The empty-protected-set check was unreachable
     through any input. Probed against the field map it actually defends: an
     empty `release_fields` is a plausible refactoring error, and the guard turns
     it into a refusal rather than a sweep with nothing protected.
  5. **Untested path, medium.** No scenario reached an `image rm` that failed
     for a reason the container pre-check cannot see, so whether the caller reads
     Docker's exit status was unverified. The stub can now fail a specific
     removal, which catches both ignoring the status and reading it through a
     pipe.
  6. **Stale assumption in an existing test, medium.** `ops/tests/host-bundle.sh`
     derived its newer-bundle refusal case from `MIN_VERSION`, which equals
     `VERSION` only while every shipped capability is also required. It stopped
     refusing the moment a bundle shipped an unused capability — exactly the
     situation OPS-03A creates, and exactly when that case needs to keep
     working. Derived from `VERSION` now.
- [x] 31 mutation probes across every guard, each confirmed to fail the suite
      when applied and pass when reverted.
- [ ] Operator installs bundle 2 on Staging and records evidence.
- [ ] OPS-03B: bump `MIN_VERSION` to 2 and activate.

## Open design item for OPS-03B

Retention takes the deployment lock non-blockingly, which is correct for the
standalone command but cannot be how it is called from inside a deployment that
already holds that lock. OPS-03B has to reconcile this deliberately — by passing
the held lock down, by releasing it once the deployment is complete and state is
rotated, or by giving retention a separate lock and relying on the caller's. It
is recorded here rather than guessed at now, because the wrong choice either
deadlocks every deployment or reopens the pull-before-rotation window this lock
exists to close.

## Blockers

None. Gate 1 is passed, so OPS-03A may proceed. OPS-03B remains blocked on
operator evidence of bundle 2 on Staging.
