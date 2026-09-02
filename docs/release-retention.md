# Release image retention

Reclaims disk on a deployment host by removing superseded application release
images, and nothing else.

## Why it exists

On 2026-08-26 the Staging host was found at 95% disk usage — 58G filesystem,
55G used, 2.9G free — carrying 53 images and 52.28 GB of Docker images. The
host bundle's disk gate refused a deployment at 2963 MiB free against the
required 4096 MiB, which is the reason the problem surfaced as a clean refusal
rather than an opaque failure partway through a release.

An operator remediated by hand: build a protected digest allowlist from the
recorded release state, remove 40 older application release images, verify all
eight protected digests survived, and re-run the disk preflight. Usage fell to
about 28% with 42 GB free. This script automates exactly that procedure, and is
not permitted to be weaker than it.

## What it retains

`CURRENT_RELEASE` and `PREVIOUS_RELEASE`, which is precisely what
`ai-agent-deploy rollback` can reach — it reads `PREVIOUS_RELEASE.json` and
nothing older. A third retained generation would be disk that nothing can use.

## What it will never do

- No blanket reclaim. There is no image, container, volume, or build-cache sweep
  anywhere in the script. A blanket reclaim cannot distinguish a rollback target
  from garbage, and rollback capability is the thing being protected.
- No forced removal, under any circumstance.
- No removal of anything outside the four application repositories: `backend`,
  `backend-migration`, `web`, and `platform`. Infrastructure images the compose
  file needs — `postgres`, `redis`, `geoipupdate` — are not in the allowlist and
  can never become candidates. Neither can a fifth repository under the same
  registry namespace.
- No removal of containers, volumes, networks, or build cache.

## The image identity contract

This is the part that is easy to get wrong, so it is stated explicitly.

The digest in `CURRENT_RELEASE.json` is what CI resolved with
`docker buildx imagetools inspect --format '{{.Manifest.Digest}}'`. Because bake
pushes an index carrying provenance and SBOM attestations alongside the platform
image, that value is an **OCI image index digest**. Verified against the real
published images: the index contains the `linux/amd64` platform manifest and a
second `unknown/unknown` manifest holding the attestations. The recorded digest
is therefore *not* the platform manifest digest, and must never be compared
against one.

Retention never compares digest strings. It resolves the recorded reference
through Docker and compares whatever identity Docker returns:

```sh
docker image inspect <repository>@sha256:<recorded> --format '{{.Id}}'
```

Locally enumerated images are resolved the same way, through the same daemon,
and the resolved identities are compared. `RepoDigests` supplies the explicit
`repository@digest` reference used for reporting and removal.

`.Id` is never assumed to equal the registry digest. It does on a daemon using
the containerd image store, where images are keyed by manifest digest; it does
not on a classic-store daemon, which reports the config digest. Resolving rather
than comparing keeps retention correct on either, which matters because the
script cannot know which store a host runs.

## The two execution modes

Retention needs the deployment lock, and `ai-agent-deploy` already holds it for
the whole deployment. `flock` locks belong to an *open file description* rather
than to a process, and that is what makes both modes work:

| | `reclaim` | `reclaim-locked` |
|---|---|---|
| Caller | an operator | `ai-agent-deploy`, after a successful deployment |
| The lock | opens `/var/lib/ai-agent/deploy.lock` itself | requires it already open on descriptor 9 |
| Description | a new one, so an active deployment refuses it | the deployment's own, so re-locking returns immediately |
| `flock -n 9` | unconditional | unconditional |

Both perform the same non-blocking `flock`. Internal mode never opens the lock
file: opening it would create a second description and lose the caller's lock,
turning the guarantee into its opposite. It instead checks that descriptor 9 is
open on exactly the deployment lock — `readlink /proc/$$/fd/9` against the fixed
absolute path — so a caller that forgot the redirection refuses before any Docker
call rather than sweeping under a serialisation that does not exist.

Being handed the descriptor is not a privilege and is not treated as one. An
operator running `reclaim-locked` by hand with the redirection would get exactly
standalone behaviour, because the lock test is identical. What keeps the CI
deploy identity away from retention is the forced-command grammar in
`ai-agent-deploy-dispatch`, which contains neither verb, and the sudoers
fragment, which permits exactly one program — `ai-agent-deploy`. Retention reads
nothing at all from the environment; there is no variable that could assert the
lock is held, because a claim is not a lock.

## When the deployment runs it

`ai-agent-deploy deploy` calls `reclaim-locked` from its `deploy` case arm, after
`deploy_release` returns. That is after the new release is healthy and after
`CURRENT`/`PREVIOUS` rotation, and the ordering is structural rather than
commented into place: `deploy_release`'s last two statements are the rotation and
the `CURRENT` write. Called any earlier, the release that had just started would
not yet be recorded and would classify as a removal candidate.

A retention failure never fails the deployment. The release is deployed,
healthy, and recorded by then; retention is disk hygiene, not part of the
release. It is not silent either — the wrapper prints the exit status and states
that superseded images were not reclaimed, and the hard gate stays where it was:
the next deployment's `disk 4096` preflight, the refusal that surfaced this
problem in the first place.

`rollback` deliberately does not call retention. A rollback is incident
response, and adding an image mutation to it buys disk the next deployment's own
preflight already guards. Anything it could have reclaimed is still reclaimable
by the next forward deployment or by the standalone command.

## Sequence

1. Hold the deployment lock, non-blocking, by one of the two modes above. A
   deployment between its image pull and its `CURRENT` rotation has images on
   disk that are not yet recorded, so they would look like candidates; holding
   the lock makes that window unreachable.
2. Read and strictly validate `CURRENT_RELEASE.json` and
   `PREVIOUS_RELEASE.json` — release SHA plus all four image references, each a
   well-formed `sha256:` digest. A record missing a field is a refusal, never a
   release that protects fewer images.
3. Resolve every protected reference through Docker.
4. **Verify every protected image resolves locally, before any mutation.** If
   any does not, remove nothing and fail.
5. Enumerate only the four application repositories, matching repository names
   as whole strings.
6. Resolve each local image to its identity the same way.
7. Candidates are the local application images that are not protected, by set
   difference — so a digest recorded by both releases is protected once and
   cannot appear through either.
8. For each candidate, inspect blocking containers first.
9. Remove by explicit `repository@digest` reference, one at a time, capturing
   Docker's exit status directly.
10. Re-resolve and verify the complete protected set.
11. Report free space before, after, and reclaimed.
12. Re-run the host disk preflight when a requirement was supplied.

Step 4 is the control that matters most. If a recorded reference cannot be
resolved, the protected set is incomplete, and an incomplete protected set
subtracted from the local images classifies the missing release's images as
removable — in the worst case the release that is currently running. This was
demonstrated: with the check removed and a deliberately mismatched identity, the
running release's own image is classified as a deletion candidate. It is the
difference between changing nothing and deleting the live release.

## Container drift

Removal is blocked whenever any container references a candidate, and is never
forced. The two cases mean different things and are reported differently:

- A **running** container on an image outside `CURRENT` and `PREVIOUS` is
  serious release-state drift: the host is serving a release the recorded state
  does not describe.
- A **stopped, created, or exited** container holding one is stale operational
  state.

Neither is treated as successful cleanup. Both leave the candidate in place and
make the run fail.

## Usage

```sh
sudo ai-agent-release-retention reclaim
sudo ai-agent-release-retention reclaim 4096
```

`reclaim-locked` is the wrapper's entry point and takes the same optional
argument, but it is not an operator command: it requires the deployment lock on
descriptor 9 and refuses without it.

With a free-space requirement it re-runs `ai-agent-host-preflight disk` at the
end, so a sweep that did not free enough space says so in the same words a
deployment refusal would use. Without one it reports reclaimed space and states
that the preflight was not re-run.

The command exits non-zero when any candidate was blocked or failed, so a
partial or zero reclaim is visible rather than silent.

## Current status

Active in the wrapper as of host bundle 3, with `MIN_VERSION` at 2 at that
point. Bundle 3 is installed and verified on Staging.

Retention itself is unchanged at host bundle 4, which the managed-secret keyring
ships. Bundle 4 raises `MIN_VERSION` to 4 for a reason that has nothing to do
with retention — the backend cannot boot without a compose mapping only bundle 4
carries — so a host on bundle 3 is refused a bundle-4 release outright rather
than deploying it without retention. The split rollout described below therefore
does not repeat: by the time a bundle-4 release runs, its wrapper is installed.

Retention is untouched at host bundle 6 as well, which changes only the compose
file's worker allowlist so the worker can perform approved agent notifications;
`MIN_VERSION` moves to 6 there for a reason unrelated to retention, and the
wrapper is unchanged.

Retention remains untouched at host bundle 7. That bundle updates the API,
worker, and operator CLI commands for the backend's explicit composition-root
paths, so `MIN_VERSION` moves to 7 while retention behavior stays unchanged.

Retention is likewise untouched at host bundle 5, which adds only the operator
rotation verb to the deploy wrapper. `MIN_VERSION` stays at 4 there, so that
bundle behaves the way bundle 3 did: a host still on bundle 4 deploys the
release correctly and gains the new verb only when its operator reinstalls.
See [the host bundle document](host-bundle.md).

The rollout was deliberately split. Bundle 2 shipped the script installed and
uninvoked, so the removal logic could be reviewed before anything could call it,
and so no deployment was ever expected to fail. Bundle 3 wires it in.

`MIN_VERSION` is 2 rather than 3, and the distinction matters. Everything
retention does is host-side: the four release images require nothing from it, and
a host on bundle 2 deploys correctly using its own wrapper, which does not call
retention. So `MIN_VERSION=2` declares the floor at which the capability exists,
which is the honest claim. `MIN_VERSION=3` would declare that the invocation
itself is required and would refuse a host still running bundle 2.

That distinction was confirmed rather than assumed. Merging the activation
triggered the usual release chain, and the automatic Staging deployment ran
before the operator installed bundle 3. Its log reads `host bundle 2 verified`
and `host bundle 2 satisfies the required 2`: the release was accepted, the
bundle-2 wrapper called no retention, and the deployment was healthy. New host
behaviour arrives with the bundle install, not with the merge. See
[the host bundle document](host-bundle.md).

## First real execution

Deployment run
[33016187386](https://github.com/adnanalmahmut/ai-agent/actions/runs/33016187386)
on release `9a90e1f5befa3048a258858066d3c6bc5a822ad7` was the first legitimate
post-bundle-3 deployment. Retention executed automatically and succeeded:

- 24 superseded application image references removed across the four
  repositories (`backend`, `backend-migration`, `web`, `platform`).
- `removed` = 24, `blocked` = 0, `failed` = 0.
- Free space before 14257MiB, after 42362MiB, reclaimed 28105MiB.
- Post-retention `4096MiB` disk preflight passed.
- All protected release images verified present after the sweep.
- No `prune`, no forced deletion. Removal was by explicit `repository@digest`,
  one reference at a time.
- The deployment itself remained healthy — all containers `Healthy`, health and
  external HTTPS smoke checks passed.

Functional real-host acceptance (Gate F) is satisfied by this deployment. Gate S
(a correct fail-closed refusal) has not been observed because the first real
execution succeeded rather than refusing; it remains informational and must
never be manufactured.

The full evidence list and numbered gate criteria are in the completed execution
plan, `docs/exec-plans/completed/release-image-retention.md`, under
*Operational acceptance*.
