# Host bundle

Release-coupled files installed on a VPS form a versioned host bundle. The
inventory is `ops/host-bundle/files`; the installed manifest is
`/etc/ai-agent/host-bundle.manifest`.

| File                          | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `ops/host-bundle/VERSION`     | Version of the bundle in this checkout                     |
| `ops/host-bundle/CONTENTS`    | SHA-256 digest recorded for each released bundle           |
| `ops/host-bundle/MIN_VERSION` | Oldest bundle that can run images built from this checkout |

The current bundle is 9 and the current minimum is 8. Bump `VERSION` whenever
an inventoried file or the inventory changes. Bump `MIN_VERSION` only when
the application cannot run on an older installed bundle. CI verifies the digest
ledger and requires the minimum not to exceed the bundle version.

## Contents and installation

The bundle installs:

- `docker-compose.yml`;
- `ai-agent-deploy` and its forced-command dispatcher;
- runtime and host preflight scripts;
- `ai-agent-release-retention`;
- the restricted sudoers fragment.

Nginx/TLS and backup units are not release-coupled and are installed separately.

From the release checkout on the host:

```sh
sudo ops/lightsail/install-host-bundle.sh
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
