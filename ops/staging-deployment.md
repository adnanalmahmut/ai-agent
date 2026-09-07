# Staging deployment

`deploy-staging.yml` starts only after the immutable-image publisher succeeds
for `main`. It downloads the artifact from the exact triggering Publish run ID
and derives the source SHA and every component digest from that validated
manifest, through the shared reader that accepts both manifest versions;
the nested workflow's own Git head is never release identity. It neither checks
out nor rebuilds application source.

The `staging` GitHub Environment supplies public variables `VPS_HOST`,
`VPS_USER`, `VPS_SSH_KNOWN_HOSTS`, and `DEPLOYMENT_URL`, plus only the restricted
`VPS_SSH_PRIVATE_KEY` secret. The job never receives database, auth, mail,
OAuth, Redis, or MaxMind credentials.

The forced SSH command invokes `deploy staging <sha> <five digest hex values>`
and carries nothing else: the release's host requirement travels on its own
image labels, so the forced-command grammar stays exactly as wide as it is. The
fifth digest is the administrative surface, and staging is the only environment
whose grammar accepts one — `deploy production` still takes four, so a
production host cannot be handed an administrative image over the deploy key.
Sending five digests needs host bundle 18; an older host answers with
`command rejected`.

Repository names are fixed on the host. The root wrapper holds a host lock,
verifies the recorded host bundle and free space, validates the runtime file,
pulls digest references, checks the pulled images' release and host-bundle
labels and the compose file's resolved images, starts data services, confirms
the database provides the extensions the release's migrations need, then runs
the digest-pinned migration image and stops immediately if migration fails.
Every one of those refusals happens before the migration container starts. Only then does it update
API/readiness, worker/process status, web, platform, and — where the release
carries it and the composition composes it — the administrative surface.
GitHub exercises the three public HTTPS routes, confirms that the
administrative route does not answer an unallowlisted client, and uploads
`staging-success-<sha>` containing the same digests and its own workflow-run
identity.

## Activating the administrative surface

The administrative service and the gateway route that reaches it are separate
things, and only the first arrives with a release. A deployment starts the
container on `127.0.0.1:3003`; nothing outside the host can reach it until an
operator installs the route, and the route admits nobody until the allowlist
names them. Both steps are operator-owned and neither is performed by CD.

1. Write the clients that may reach it, one address range per line, as root:

   ```text
   /etc/ai-agent/admin-staging-allowed-cidrs   root:root 0644
   ```

   These are not secrets. A `/0` prefix and the unspecified address are
   refused, and a malformed line refuses the whole install rather than being
   skipped.

2. From a reviewed checkout on the host, as root, install the gateway with the
   administrative port as a fifth argument:

   ```sh
   infra/gateway/nginx/install-nginx.sh <domain> 3002 3001 3000 3003
   ```

   The route is installed on staging hosts only, decided from
   `/etc/ai-agent/environment`. The script validates the allowlist, renders
   `allow` directives followed by an unconditional `deny all`, runs `nginx -t`
   and reloads; a configuration Nginx refuses is rolled back to the one already
   installed.

3. To change the allowlist later, edit the file and re-run the same command.
   To withdraw the surface, re-run it without the fifth argument: the route and
   the allowlist fragment are both removed, and `/admin` becomes an ordinary
   path on the public site again. The container can be stopped with the
   deployment's own Compose invocation; nothing else on the host is affected.

An allowlisted address is not an authorization. Signing in is still required,
the staff gate still applies, and every administrative request is still
authorized by the Control Plane from the session. See
[the security model](../docs/security.md#administrative-ingress-on-staging-only).

Staging is provisioned and is changed only by the automatic post-`main` CD
path. Repository agents must not deploy manually, connect to the VPS, edit the
root-owned runtime file, or modify GitHub Environment values. Live host and
credential evidence remains operator-owned and must not be copied into Git.
