# Repository knowledge base

This directory is the system of record for architecture, product capability,
delivery, operations, and the coding-agent harness. Source code and executable
configuration win when a document disagrees with implementation.

## Start here

- [Portfolio finish line](portfolio-finish-line.md) is the current program
  policy: what is already proven, what remains, and where the project stops.
- [Deployment state](deployment-state.md) distinguishes what is live today
  from target Production capability.
- [Architecture](architecture.md) maps trust and runtime boundaries.
- [Feature inventory](feature-inventory.md) maps user-visible capability to its
  owning application and source.
- [Runtime configuration](configuration.md) explains configuration and secret
  ownership without publishing values.
- [Agent harness](agent-harness.md) describes the tool-neutral context model.

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
- [Deployment contract](deployment.md), the [host bundle](host-bundle.md),
  [release image retention](release-retention.md), and
  [rollback](rollback.md)
- [Security model](security.md)

## Operations

- [Operations runbook](operations-runbook.md)
- [Backup and restore](backup-restore.md)
- [Troubleshooting](troubleshooting.md)
- Focused executable/operator material lives under [`ops/`](../ops/).

## Change records

- [Project history](project-history.md) summarizes durable milestones.
- [`decisions/`](decisions/README.md) records architectural decisions,
  including [ADR 0001](decisions/0001-environment-state-model.md) on the
  environment state model and
  [ADR 0002](decisions/0002-portfolio-finish-line.md) on the bounded
  portfolio program.
- [`exec-plans/`](exec-plans/README.md) defines substantial-change plans and
  their lifecycle.

Keep documents answer-first and link to implementation rather than restating
it. Update the narrowest owning document in the same change as behavior,
configuration, deployment, or operator-procedure changes.
