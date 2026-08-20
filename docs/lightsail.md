# AWS Lightsail

Provision exactly two independent Ubuntu LTS instances: staging and production.
Attach a static IP to each and separate their DNS, runtime.env, deploy key,
database, Redis, Docker volumes, backups, and snapshots.

Lightsail firewall permits public 80/443 and restricts SSH 22 to the operator's
trusted CIDR whenever possible. Ports 3000/3001/3002/5432/6379 are forbidden.
The host bootstrap also configures UFW with the same policy.

The host bootstrap provisions a persistent 2 GiB `/swapfile` with
`vm.swappiness=10`. This is a bounded safety margin for Docker layer extraction
and transient deployment spikes on small instances; it is not a substitute for
sizing the VPS with enough RAM for the running application stack.

The deployment user is absent from the Docker group, has no general sudo, and
uses a key with `restrict`, `no-user-rc`, and a ForcedCommand dispatcher. The
dispatcher accepts only deploy/status/health/rollback shapes; a root wrapper
validates environment, the 40-character SHA, and four 64-character digest
values, then reads the server-local root-only runtime file. Repository names
are hard-coded in that wrapper. The deploy identity cannot select an image
repository, read runtime values, use Docker directly, or gain a general shell.

Provisioning checklist and live verification: [`ops/lightsail/README.md`](../ops/lightsail/README.md).
