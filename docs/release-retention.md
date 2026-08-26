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

## Sequence

1. Take the deployment lock, non-blocking. A deployment between its image pull
   and its `CURRENT` rotation has images on disk that are not yet recorded, so
   they would look like candidates; holding the lock makes that window
   unreachable.
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

With a free-space requirement it re-runs `ai-agent-host-preflight disk` at the
end, so a sweep that did not free enough space says so in the same words a
deployment refusal would use. Without one it reports reclaimed space and states
that the preflight was not re-run.

The command exits non-zero when any candidate was blocked or failed, so a
partial or zero reclaim is visible rather than silent.

## Current status

Installed as part of host bundle 2 and **not yet invoked by anything**.
`ai-agent-deploy` does not call it, and no release behaviour depends on it:
`MIN_VERSION` remains 1, so a host still running bundle 1 is completely correct
and deploys normally. This is capability delivered ahead of activation, so the
removal logic could be reviewed before anything could call it.

Activation — wiring it into the successful post-deploy path and moving
`MIN_VERSION` to 2 — is a separate change, and requires that an operator has
already installed bundle 2. It is also not reachable over SSH: the
forced-command grammar in `ai-agent-deploy-dispatch` is unchanged, so the CI
deploy key cannot invoke retention. See
[the host bundle document](host-bundle.md).
