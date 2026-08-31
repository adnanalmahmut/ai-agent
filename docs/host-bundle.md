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
| `ops/host-bundle/CONTENTS` | a digest per version, recording what each one actually contained |
| `ops/host-bundle/MIN_VERSION` | the oldest installed bundle a release built from this tree tolerates |

They are separate on purpose. Collapsing them would make every cosmetic edit to
a host script a forced host update, and the point of the mechanism is to refuse
only the deployments that would actually fail. Bump `VERSION` whenever the
inventory or any file in it changes; bump `MIN_VERSION` only when a release
genuinely stops working on an older bundle. `ops/tests/host-bundle.sh` fails if
`MIN_VERSION` ever exceeds `VERSION`.

`VERSION` on its own was only a claim. Two changes shipped with a listed file
edited and the number left alone — the keyring's compose and preflight changes,
and this bundle's deploy wrapper — and nothing caught either, because the doc
check runs in the bump-implies-docs direction only. `ops/host-bundle/CONTENTS`
closes that: one `<version> <sha256>` line per bundle, over the inventory and
every file in it, recomputed and compared by the same suite. Changing a listed
file now fails until either a new version is appended or the entry for an
already-installed bundle is deliberately rewritten — which is at least a visible
act rather than an omission. The ledger begins at 5; earlier bundles predate it
and their contents cannot be recovered from this tree.

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

Bundle 4 is the opposite case, and the reason both numbers exist rather than
one. It changes the compose file and `ai-agent-runtime-preflight` so the backend
and worker receive `APP_ENCRYPTION_ACTIVE_KEY_VERSION` and
`APP_ENCRYPTION_DECRYPT_KEYS`, which the versioned managed-secret keyring
requires at boot. `MIN_VERSION` moves to 4 with it.

That is not a preference. The compose file uses an explicit per-service
`environment` allowlist and deliberately never uses `env_file`, so a variable
absent from the installed compose cannot reach the container whatever the
operator writes into `runtime.env`. A bundle-3 host handed a bundle-4 release
would therefore run the migration, then start a backend that refuses its own
configuration and never becomes healthy — the exact half-applied release the
`b50b0f7` repair list opens with, reproduced deliberately. `MIN_VERSION=4`
converts that into a refusal before `compose run --rm migrate`, naming the
bundle reinstall as the remedy.

Bundle 4 is also safe to install *before* the release that needs it, which is
what makes the ordering workable: the two new mappings default to empty and the
image currently deployed ignores them. So the operator installs bundle 4 and
adds the version to `runtime.env` while the previous release is still running,
and the release that requires them deploys afterwards. See
[the first version-aware release](operations-runbook.md#first-version-aware-encryption-release).

Bundle 5 goes back to the retention pattern. It adds one verb to
`ai-agent-deploy`, `rotate-managed-secret-keys`, which re-encrypts stored
managed secrets under the active key version. `MIN_VERSION` is 4 at bundle 5,
not 5.

Nothing a deployment does calls it. The verb is an operator action, run by hand
on the host long after the release that ships it, and deliberately absent from
`ai-agent-deploy-dispatch`'s forced-command grammar — which, together with the
deploy key being pinned to that dispatcher with no shell, is what keeps the CI
identity away from it. The sudoers fragment is broader than that and would
permit the verb, so the forced command is the control actually doing the work.

A host on bundle 4 therefore deploys a bundle-5 release correctly using its own
wrapper. This is the bundle-2 case, not the bundle-3 one: a bundle-2 host ran a
wrapper that simply did not call retention, which is exactly how a bundle-4 host
runs a wrapper that does not have this verb. Raising `MIN_VERSION` to 5 would claim the rotation verb is required to
deploy, refuse a host that is currently correct, and break a healthy deployment
over a capability nobody has asked for yet.

One consequence is worth stating plainly, because nothing refuses it: bundle 4
is what introduced the `APP_ENCRYPTION_DECRYPT_KEYS` mapping, so a bundle-4 host
can be put into a two-key configuration while lacking the only command that gets
it back out of one. The runbook forecloses this by ordering the bundle install
before the key rollout, but it is procedure rather than structure.

The consequence is the same one retention had, and it is intended: the rotation
command becomes available when the operator reinstalls the bundle, not when the
release merges. Until then `sudo ai-agent-deploy rotate-managed-secret-keys`
exits with `unsupported operation`. See
[managed secret key rotation](operations-runbook.md#managed-secret-key-rotation).

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
