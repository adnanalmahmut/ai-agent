# Host bundle

Release-coupled files installed on a VPS form a versioned host bundle. The
inventory is `infra/host-bundle/files`; the installed manifest is
`/etc/ai-agent/host-bundle.manifest`.

| File                          | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `infra/host-bundle/VERSION`     | Version of the bundle in this checkout                     |
| `infra/host-bundle/CONTENTS`    | SHA-256 digest recorded for each released bundle           |
| `infra/host-bundle/MIN_VERSION` | Oldest bundle that can run images built from this checkout |

The current release ships bundle 12 and the current minimum is 11. Bump `VERSION` whenever
an inventoried file or the inventory changes. Bump `MIN_VERSION` only when
the application cannot run on an older installed bundle. CI verifies the digest
ledger and requires the minimum not to exceed the bundle version.

Bundle 11 raised the minimum to 11 because it split the Compose model: the
deployment overlay is a second installed file, and a host carrying only bundle
10's single `docker-compose.yml` resolves the datastores and no application
service at all. `ai-agent-deploy` refuses such a host with `this release
requires host bundle 11`.

Bundle 12 leaves the minimum at 11. It records the move of the deployment and
host-bundle sources under `infra/`, which changed three installed files by one
comment or message line each and nothing else: same destinations, same modes,
same behaviour. A host already carrying bundle 11 runs this release without
being reinstalled. The bump is here because the rule in `infra/host-bundle/files`
is that any change to a listed file gets a new version, and leaving a path that
no longer exists inside a file we ship to a host is not worth avoiding it for.

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
- `io.ai-agent.host-bundle.min-version`.

After pulling the pinned digests, the deploy wrapper checks those labels against
the requested release and installed bundle. The requirement travels with the
image, so changing the forced-command argument grammar is unnecessary.

Before any migration, the wrapper checks in order:

1. installed bundle manifest, modes, and digests;
2. available space on Docker's data root;
3. required runtime values without printing them;
4. release SHA and minimum-bundle labels on every image;
5. Compose resolution to the four pinned digests;
6. required PostgreSQL extensions.

Rollback uses the same checks without running migrations. Repository tests keep
Compose environment mappings, runtime preflight requirements, image labels, and
extension checks synchronized.
