# Release image retention

`ai-agent-release-retention` removes superseded application images from a
deployment host while preserving the releases the wrapper can run.

## Protected and candidate images

`CURRENT_RELEASE.json` and `PREVIOUS_RELEASE.json` are the protected set.
Each record must contain a valid source SHA and all four image digests. Retention
considers only the fixed application repositories `backend`,
`backend-migration`, `web`, and `platform`. It never removes containers,
volumes, networks, build cache, or infrastructure images, and never forces an
image removal.

Release records contain an **OCI image index digest**, not necessarily the local
platform manifest or image ID. The script never compares digest strings.
Instead, `docker image inspect` resolves both protected references and local
candidates through the same daemon, and the script compares the returned
identities. Removal still uses an explicit `repository@digest` reference.

All protected references must resolve locally before any mutation. A missing or
malformed release record, unresolved protected image, empty protected set, or
failed lock check stops the run without removing anything.

## Locking and execution modes

Retention shares `/var/lib/ai-agent/deploy.lock` with deployment. `flock`
locks an open file description, which permits two safe modes:

- `reclaim` opens the lock for a standalone operator run and refuses while a
  deployment is active.
- `reclaim-locked` is the deploy wrapper's internal entrypoint. It verifies
  and reuses the wrapper's inherited descriptor.

The internal mode is not accepted by the forced-command dispatcher and is not
an operator command.

## Sequence

1. Validate both release records and resolve every protected image.
2. Enumerate images from the four allowed repositories.
3. Subtract protected identities.
4. Refuse each candidate still held by any container; never force removal.
5. Remove remaining candidates one explicit reference at a time.
6. Verify every protected image again.
7. Report disk change and optionally run the host disk preflight.

A running container on an unprotected image indicates release-state drift. A
stopped or exited container indicates stale operational state. Both block that
candidate and make a standalone run fail.

## Usage

```sh
sudo ai-agent-release-retention reclaim
sudo ai-agent-release-retention reclaim 4096
```

The optional value is the required free space in MiB and reruns the same disk
preflight used by deployment.

The deploy wrapper runs retention only after the new release is healthy and
`CURRENT_RELEASE.json`/`PREVIOUS_RELEASE.json` have rotated. Retention never
fails the deployment at that point: it reports failure and returns success
because the deployed release is already complete. The next deployment's disk
preflight remains the hard gate. Retention remains current at host bundle 10; see
[host bundle](host-bundle.md).
