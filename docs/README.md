# Repository knowledge base

This directory is the system of record for architecture, product capability,
delivery, operations, and the coding-agent harness. Source code and executable
configuration win when a document disagrees with implementation.

## Start here

- [Deployment state](deployment-state.md) distinguishes what is live today
  from target Production capability.
- [Architecture](architecture.md) maps trust and runtime boundaries.
- [Feature inventory](feature-inventory.md) maps user-visible capability to its
  owning application and source.
- [Runtime configuration](configuration.md) explains configuration and secret
  ownership without publishing values.

## Application and data

- [Backend](backend.md) and the detailed
  [backend README](../apps/backend/README.md)
- [Frontend applications](frontend.md)
- [Authentication and RBAC](authentication-rbac.md)
- [Database](database.md)
- [Redis, BullMQ, and outbox](redis-queue-outbox.md)
- [Mail](backend.md)
- [Rate limiting](rate-limiting.md)
- [GeoIP session location](geoip-session-location.md)

## Platform, delivery, and security

- [Docker Compose](docker-compose.md), [Lightsail](lightsail.md), and
  [Nginx/TLS](nginx-tls.md)
- [Networking and canonical client IP](networking-real-ip.md)
- [Continuous integration](ci.md) and [continuous delivery](cd.md)
- [Deployment contract](deployment.md) and [rollback](rollback.md)
- [Security model](security.md)

## Operations

- [Operations runbook](operations-runbook.md)
- [Backup and restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)
- Focused executable/operator material lives under [`ops/`](../ops/).

## Change records

- [Project history](project-history.md) summarizes durable milestones.
- [`decisions/`](decisions/README.md) records architectural decisions.
- [`exec-plans/`](exec-plans/README.md) defines substantial-change plans and
  their lifecycle.

Keep documents answer-first and link to implementation rather than restating
it. Update the narrowest owning document in the same change as behavior,
configuration, deployment, or operator-procedure changes.
