# Documentation

Use source, tests, schemas, workflows, and operator scripts as the final source
of truth. These documents explain boundaries and procedures that are not clear
from those files alone.

## System

- [Architecture](architecture.md): topology, dependency boundaries, and durable
  invariants
- [Backend](backend.md): entrypoints, source ownership, and request/execution
  flows
- [Frontends](frontend.md): the public web and authenticated platform apps
- [Feature inventory](feature-inventory.md): implemented product surfaces
- [Authentication and RBAC](authentication-rbac.md): identity and authorization
- [Database](database.md): persistent model and migration rules
- [Redis, queue, and outbox](redis-queue-outbox.md): asynchronous delivery
- [Configuration](configuration.md): configuration sources and ownership
- [Security](security.md): trust boundaries and enforced guarantees

## Delivery and operations

- [Deployment state](deployment-state.md): provisioned environments and allowed
  operations
- [CI](ci.md), [CD](cd.md), [deployment](deployment.md), and
  [rollback](rollback.md)
- [Docker Compose](docker-compose.md), [host bundle](host-bundle.md), and
  [release retention](release-retention.md)
- [Lightsail](lightsail.md), [Nginx/TLS](nginx-tls.md), and
  [networking/real IP](networking-real-ip.md)
- [Rate limiting](rate-limiting.md) and [GeoIP](geoip-session-location.md)
- [Backup/restore](backup-restore.md), [operations runbook](operations-runbook.md),
  and [troubleshooting](troubleshooting.md)

## Repository process

- [Agent harness](agent-harness.md)
- [Architecture decisions](decisions/README.md)
- [Execution-plan convention](exec-plans/README.md)
