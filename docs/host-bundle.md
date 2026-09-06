# Host bundle

Release-coupled files installed on a VPS form a versioned host bundle. The
inventory is `infra/host-bundle/files`; the installed manifest is
`/etc/ai-agent/host-bundle.manifest`.

| File                          | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `infra/host-bundle/VERSION`     | Version of the bundle in this checkout                     |
| `infra/host-bundle/CONTENTS`    | SHA-256 digest recorded for each released bundle           |
| `infra/host-bundle/MIN_VERSION` | Oldest bundle that can run images built from this checkout |

The current release ships bundle 13 and the current minimum is 11. Bump `VERSION` whenever
an inventoried file or the inventory changes. Bump `MIN_VERSION` only when
the application cannot run on an older installed bundle. CI verifies the digest
ledger and requires the minimum not to exceed the bundle version.

Bundle 11 raised the minimum to 11 because it split the Compose model: the
deployment overlay is a second installed file, and a host carrying only bundle
10's single `docker-compose.yml` resolves the datastores and no application
service at all. `ai-agent-deploy` refuses such a host with `this release
requires host bundle 11`.

Bundles 12 and 13 both leave the minimum at 11. Bundle 12 recorded the move of
the deployment and host-bundle sources under `infra/`: three installed files
changed by one comment or message line each, same destinations, same modes,
same behaviour.

Bundle 13 teaches the deploy wrapper and release retention to describe a release
as a component list. A host still on 11 or 12 deploys a release built from this
checkout without being reinstalled: the forced-command grammar is unchanged, the
extra `io.ai-agent.component.name` label an older wrapper simply does not read,
and the flat release record an older wrapper writes stays readable by the new
one. So the minimum does not move. Reinstalling gets the component record and
the wrong-component refusal; not reinstalling costs neither correctness nor
rollback.

## Contents and installation

The bundle installs:

- `docker-compose.yml`, the shared Compose model;
- `docker-compose.deploy.yml`, the deployment overlay merged over it;
- `ai-agent-deploy` and its forced-command dispatcher;
- runtime and host preflight scripts;
- `ai-agent-release-retention`;
- the restricted sudoers fragment.

Nginx/TLS and backup units are not release-coupled and are installed separately.

From the release checkout on the host:

```sh
sudo infra/deploy/install-host-bundle.sh
sudo ai-agent-host-preflight integrity
```

The installer validates the full inventory before writing, validates sudoers,
installs fixed modes, and records each installed file's digest in
`host-bundle.manifest`. Do not edit an installed bundle file or the manifest
by hand.

## Release compatibility

The publish workflow reads `MIN_VERSION`, records it in
`image-digests.json`, and stamps every application image with:

- `io.ai-agent.release.sha`;
- `io.ai-agent.host-bundle.min-version`;
- `io.ai-agent.component.name`.

The component label is what makes a digest answerable for which slot it fills.
Four valid digests from one release, handed over in the wrong four positions,
satisfy every other check; this one does not.

Releases published before this label existed do not carry it, and a host must
stay able to roll back to one. A release whose images carry no component label
at all is therefore accepted as a legacy release, with a note on stderr. A
release labelled on only part of itself is refused: that is not a release from
before the label, it is images from more than one publish.

After pulling the pinned digests, the deploy wrapper checks those labels against
the requested release and installed bundle. The requirement travels with the
image, so changing the forced-command argument grammar is unnecessary.

Before any migration, the wrapper checks in order:

1. installed bundle manifest, modes, and digests;
2. available space on Docker's data root;
3. required runtime values without printing them;
4. release SHA, component name, and minimum-bundle labels on every image;
5. Compose resolution to the pinned component digests;
6. required PostgreSQL extensions.

Rollback uses the same checks without running migrations. Repository tests keep
Compose environment mappings, runtime preflight requirements, image labels, and
extension checks synchronized.
