# Project history

The repository began with the HTTP/backend foundation: validated configuration,
unified errors/i18n, health/lifecycle, Better Auth, Prisma, mail, and request
logging. Authentication then gained explicit platform and organization RBAC,
reversible user/organization lifecycle, administration UI, and security-boundary
E2E tests.

The asynchronous foundation separated API and worker, introduced Redis clients
by role, BullMQ, and a PostgreSQL transactional outbox with leases, claim
versioning, indefinite transient retries, and durable idempotency expectations.
The backend layout was subsequently flattened into a solo-developer-oriented
`core` structure without changing those guarantees.

The production stack then evolved through ten stacked changes:

1. Multi-stage images and one profiled Compose topology.
2. Host Nginx templates and canonical one-hop real IP.
3. Local fail-open GeoIP session enrichment.
4. Atomic Redis route limits plus Better Auth database limits.
5. Lightsail bootstrap, TLS, and restricted deployment boundary.
6. Web/container CI and one-time immutable-digest image publishing.
7. Automatic migration-gated staging deployment from exact publisher evidence.
8. Manual exact-staged-digest production promotion and manifest rollback.
9. Verified PostgreSQL backup and restore-drill tooling.
10. This source-backed system documentation.

These PRs remain intentionally unmerged while reviewed as a stack. The history
records architectural decisions, not every commit; Git remains the detailed
change ledger.
