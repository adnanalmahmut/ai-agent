# Lightsail host foundation

Create two independent Ubuntu LTS instances, one `staging` and one
`production`, each with a static IP. Never share PostgreSQL, Redis, volumes,
runtime files, deploy keys, or instance snapshots between them.

```mermaid
flowchart LR
  GH[GitHub Environment] -->|environment + SHA + 4 validated digests| D[deploy user]
  D -->|only allowed sudo wrapper| W[root deployment wrapper]
  W --> C[Docker Compose]
  W --> E[/etc/ai-agent/runtime.env\nroot:root 0600]
  Internet --> N[host Nginx 80/443]
  N -->|127.0.0.1 only| C
  D -. denied .-> E
  GH -. no runtime secrets .-> E
```

## Operator prerequisites

1. Reserve each static IP and create the staging/production DNS A/AAAA records.
2. In the Lightsail firewall allow TCP 80 and 443 globally. Allow TCP 22 only
   from the operator's trusted CIDR. Do not add 3000, 3001, 3002, 5432, or 6379.
3. Keep the personal administrator key separate. Create a dedicated deployment
   key for each environment; never reuse the private key between environments.
4. From a reviewed checkout, run as root:

   `ops/lightsail/bootstrap-host.sh <environment> <domain> <trusted-cidr> <deploy-public-key-file>`

5. Install `docker-compose.yml` at `/opt/ai-agent/docker-compose.yml`. Create
   `/etc/ai-agent/runtime.env` from the names-only template, owner root, mode
   0600. The deploy user must not be able to read either that file or Docker's
   socket.
   If GHCR packages are private, authenticate root's Docker client once with a
   server-local, packages-read-only credential. Do not place that credential in
   GitHub Actions or the deploy user's home.
6. Run `ops/lightsail/install-nginx.sh`, confirm the HTTP site from outside,
   then run `ops/lightsail/issue-certificate.sh`. Certificate issuance needs
   working DNS and inbound port 80; it is intentionally operator-only.

## Boundary verification

```sh
id deploy
getent group docker
sudo -l -U deploy
stat -c '%U:%G %a' /etc/ai-agent/runtime.env
ss -ltnp
nginx -t
certbot renew --dry-run
```

Expected: `deploy` is absent from the Docker group, only the dedicated wrapper
is in sudoers, runtime.env is `root:root 600`, and public listeners are only
22/80/443. The authorized key uses `restrict`, `no-user-rc`, and ForcedCommand, so shell,
port forwarding, agent forwarding, PTY, `docker exec`, and secret reads are not
deployment capabilities.

Live DNS, Lightsail firewall, certificate issuance, and SSH boundary checks
remain pending until the operator provisions the two instances.

The deployment command accepts only a 40-character source SHA followed by four
64-character digest hex values. Repository names are fixed inside the root
wrapper. The wrapper runs runtime preflight, starts data services, runs the
digest-pinned migration image, and then rolls out API, worker, web and platform
in readiness order. Successful state is stored as root-only
`CURRENT_RELEASE.json`/`PREVIOUS_RELEASE.json`; tags are never release state.
