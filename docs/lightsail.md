# AWS Lightsail

Staging is the only provisioned Lightsail environment. Production does not
exist; repository procedures for it are inactive.

The host firewall allows public 80/443 and restricts SSH 22 to the operator's
trusted CIDR where possible. Ports 3000, 3001, 3002, 5432, and 6379 are not
public. UFW enforces the same boundary.

Bootstrap configures a 2 GiB swap file with `vm.swappiness=10` for bounded
Docker extraction spikes on the small host. It is not capacity for steady-state
application load.

The `deploy` user is not in the Docker group and has no general sudo. Its key
uses `restrict`, `no-user-rc`, and a forced-command dispatcher. The
dispatcher accepts only validated deploy, status, health, and rollback shapes.
The root wrapper selects fixed repositories, reads the root-only runtime file,
and validates the environment, source SHA, and four digests.

The deploy identity cannot select repositories, read runtime values, invoke
Docker directly, access backups, or obtain a shell.

Provisioning and verification details are in
[`ops/lightsail/README.md`](../ops/lightsail/README.md).
