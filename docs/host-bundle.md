# Host bundle

Some of what a release needs is not in the release. `/opt/ai-agent/docker-compose.yml`,
the deploy wrapper, the dispatcher, and both preflights all live on the VPS,
and all four change with the application they serve. Until they were versioned,
nothing connected the two: a host kept whatever it was given at creation, a
release could not say which host it needed, and a host could not refuse a
release it was unable to run.

That is not hypothetical. Bringing the `b50b0f7` release up on Staging required
four manual repairs — a compose file still pinning stock PostgreSQL, a
`CREATE EXTENSION vector` that therefore failed inside the migration container,
a deploy wrapper older than the release it was deploying, and an absent
`APP_ENCRYPTION_KEY` that stopped the backend after the migrations had already
been applied. Each was discovered part-way through a deployment that could not
be undone.

## The two version numbers

| File | Meaning |
|---|---|
| `ops/host-bundle/VERSION` | what the bundle in this repository *is* |
| `ops/host-bundle/MIN_VERSION` | the oldest installed bundle a release built from this tree tolerates |

They are separate on purpose. Collapsing them would make every cosmetic edit to
a host script a forced host update, and the point of the mechanism is to refuse
only the deployments that would actually fail. Bump `VERSION` whenever the
inventory or any file in it changes; bump `MIN_VERSION` only when a release
genuinely stops working on an older bundle. `ops/tests/host-bundle.sh` fails if
`MIN_VERSION` ever exceeds `VERSION`.

## What is in the bundle

[`ops/host-bundle/files`](../ops/host-bundle/files) is the inventory: source
path, installed destination, and mode, one file per line. It covers the compose
bundle, `ai-agent-deploy`, `ai-agent-deploy-dispatch`,
`ai-agent-runtime-preflight`, `ai-agent-host-preflight`,
`ai-agent-release-retention`, and the sudoers fragment.

Bundle 2 added `ai-agent-release-retention`, installed and invoked by nothing.
Bundle 3 wires it into the successful deployment path. Together they are the
worked example of why the two numbers are separate.

At bundle 2 the capability existed but nothing called it, so `MIN_VERSION` stayed
at 1: a host still on bundle 1 remained completely correct, and declaring a
minimum of 2 would have refused deployments over a dependency no release had
yet. At bundle 3 the wrapper calls retention, so two listed files changed and
`VERSION` had to move with them — holding it at 2 would leave two materially
different bundles both recording `version 2`, which is precisely the false claim
this mechanism exists to prevent.

`MIN_VERSION` is 2 at bundle 3, not 3. Retention is entirely host-side: the
release images require nothing from it, and a host on bundle 2 deploys correctly
using its own wrapper, which does not call it. So 2 is the floor at which the
capability exists, which is what the release can honestly require; 3 would claim
the invocation is required and refuse a host that is on bundle 2 today. The
consequence is that retention starts running only after an operator reinstalls
the bundle, not when the release merges. See
[release image retention](release-retention.md).

Files that are not release-coupled are deliberately absent. The Nginx site and
TLS assets survive any release, and the backup units are installed by
`ops/backup/install-backups.sh` on their own schedule.

## Installing and updating

From a checkout of the release you are about to deploy, as root on the host:

```sh
sudo ops/lightsail/install-host-bundle.sh
```

The installer validates the whole inventory before installing any of it — a
half-installed bundle would leave a manifest describing a host that does not
exist — then installs each file, checks any sudoers fragment with `visudo -c`
in place, and records `/etc/ai-agent/host-bundle.manifest`:

```
version 1
file 0644 <sha256> /opt/ai-agent/docker-compose.yml
file 0755 <sha256> /usr/local/sbin/ai-agent-deploy
...
```

A version alone would be a claim. The digest per file is what makes it
checkable: the Staging failure was an installed compose file that no longer
matched the bundle the host believed it had, and a bare version number would
have gone on asserting the old value indefinitely.

`ops/lightsail/bootstrap-host.sh` calls the same installer, so first-run
bootstrap and every later update take one path and record one manifest.

## How a release states what it needs

The publish workflow reads `ops/host-bundle/MIN_VERSION` and exports it into
Buildx Bake, which stamps two labels onto every image in the release set:

| Label | Value |
|---|---|
| `io.ai-agent.release.sha` | the source SHA the release was built from |
| `io.ai-agent.host-bundle.min-version` | the minimum installed bundle version |

The same minimum is recorded in `image-digests.json` as `hostBundleMinVersion`,
and both deploy workflows refuse a release manifest that does not carry it.

The requirement travels on the image rather than as a new deploy argument for
two reasons. The dispatcher's forced-command grammar is the trust boundary for
the CI deploy key and stays exactly as wide as it is. And an argument would
force every host into lockstep with every release, where a label lets an older
bundle keep serving releases whose minimum it already satisfies.

## What the host refuses, and when

Every check below runs before `compose run --rm migrate`. Migrations are
forward-only, so a check that runs after them is a diagnosis rather than a gate.

| Order | Check | Refusal |
|---|---|---|
| 1 | `ai-agent-host-preflight integrity` | a recorded file is missing, has the wrong mode, or no longer matches its digest; the manifest is absent, malformed, or does not cover the compose file and deploy wrapper |
| 2 | `ai-agent-host-preflight disk` | less free space on Docker's data root than the release needs to extract into |
| 3 | `ai-agent-runtime-preflight` | a required runtime key is missing or empty, `APP_ENCRYPTION_KEY` does not decode to 32 bytes, `POSTGRES_PASSWORD` is the compose development fallback, or `DATABASE_URL` names a different role or database than the `POSTGRES_*` values |
| 4 | image labels | an image does not belong to the requested release, the four images disagree on the minimum, a release declares no minimum, or the installed bundle is older than the minimum |
| 5 | `compose config --images` | the installed compose file does not resolve the four pinned digests, or resolves a mutable application tag |
| 6 | PostgreSQL capability | the running image does not make a required extension available |

`rollback` runs the same gated path with `no-migrate`, so every refusal applies
to it as well.

Two contracts that would otherwise drift silently are locked in CI rather than
on the host, because both are properties of the repository:
`ops/tests/host-bundle.sh` fails when a compose variable with an empty default
is not required by the runtime preflight, and when a migration creates an
extension the deploy wrapper does not demand of the image first.

## Enabling it on an existing host

A host running the pre-bundle deploy wrapper performs none of these checks — the
wrapper that would perform them is itself part of the bundle. Installing the
bundle once is what turns them on:

1. Check out the release SHA on the host.
2. Run `sudo ops/lightsail/install-host-bundle.sh`.
3. Confirm `sudo ai-agent-host-preflight integrity` reports the expected
   version.

From then on, a release whose declared minimum exceeds the recorded version is
refused before it can touch the database.
