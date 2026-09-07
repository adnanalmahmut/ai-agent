# Host bundle

Release-coupled files installed on a VPS form a versioned host bundle. The
inventory is `infra/host-bundle/files`; the installed manifest is
`/etc/ai-agent/host-bundle.manifest`.

| File                          | Meaning                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| `infra/host-bundle/VERSION`     | Version of the bundle in this checkout                     |
| `infra/host-bundle/CONTENTS`    | SHA-256 digest recorded for each released bundle           |
| `infra/host-bundle/MIN_VERSION` | Oldest bundle that can run images built from this checkout |

The current release ships bundle 18 and the current minimum is 18. Bump `VERSION` whenever
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

Bundle 14 records a source path, not a behaviour. The NestJS workspace moved
from `apps/backend` to `apps/control-plane`, so the `build:` stanzas in
`compose.deploy.yaml` name a different Dockerfile. Nothing a host does changes:
it deploys by image, the service is still called `backend`, the image is still
`.../backend`, the component names are still `backend` and `backend-migration`,
and the forced-command grammar is untouched. The version moves because the
ledger covers every inventoried file, which is the point of the ledger; the
minimum stays at 11 because a host on 11, 12 or 13 deploys this release
unchanged.

Bundle 15 passes `INTERNAL_SERVICE_CREDENTIALS` to the `backend` service in
`compose.deploy.yaml`, and to that service only: the internal execution
boundary is served by the API process, and neither the worker nor the migration
process authenticates a service. The minimum stays at 11 because absent renders
as an empty list and an empty list authenticates nobody — a host still on an
older bundle runs this release with the boundary closed, which is the default
either way. Reinstalling is what makes the configured path reachable, so an
operator who intends to point an out-of-process runtime at this deployment
needs bundle 15; one who does not loses nothing.

Bundle 16 carries the `platform` service's build path renamed from
`apps/platform/Dockerfile` to `apps/app/Dockerfile`, which is a source-tree
move and nothing else: the service, its image repository, its port and its
health path are unchanged. The minimum stays at 11 because the path is only
read when the composition builds an image locally, and a deployment pulls
published images by digest instead. A host still on an older bundle deploys
this release unchanged.

Bundle 17 passes the four `APP_ORIGIN_*` settings explicitly to the backend in
`compose.deploy.yaml`. The minimum stays at 11 because unset values remain
safe optional inputs and the app/API origins are derived from their existing
path-bearing canonical URLs; reinstalling is needed for a host to receive the
explicit deployment wiring.

Bundle 18 is the first to raise the minimum since 11, because a staging
deployment of a release built from this checkout genuinely cannot run on an
older host. Three of its files change together:

- `compose.deploy.yaml` gains the `admin` service in the `staging` profile
  only, bound to `127.0.0.1:3003` and given three non-secret values;
- `ai-agent-deploy` accepts an optional fifth digest, deploys the
  administrative surface where the release carries it and the composition
  composes it, and records it as a release component;
- `ai-agent-deploy-dispatch` accepts that fifth digest for `deploy staging`
  and, deliberately, not for `deploy production`.

The minimum moves because staging CD now sends five digests. A host on bundle
17 answers that with `command rejected` from the forced-command dispatcher --
a refusal with nothing in it an operator could act on. Refusing it as
`this release requires host bundle 18` is the same outcome said usefully.
Install the bundle from the release checkout before deploying it.

Production is unaffected in what it runs: its composition has no `admin`
service and its deploy command still carries four digests. It needs bundle 18
for the same reason any host does -- the release declares it -- and installing
it changes nothing production starts.

## Contents and installation

The bundle installs:

- `docker-compose.yml`, the shared Compose model;
- `docker-compose.deploy.yml`, the deployment overlay merged over it;
- `ai-agent-deploy` and its forced-command dispatcher;
- runtime and host preflight scripts;
- `ai-agent-release-retention`;
- the restricted sudoers fragment.

The `admin` service is in the deployment overlay and therefore in the bundle,
but the Nginx route that reaches it is not: gateway configuration is not
release-coupled and is installed separately, along with the client allowlist
that route refuses without. See [security.md](security.md).

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
