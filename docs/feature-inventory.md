# Feature inventory

This inventory describes implemented product capability, not a roadmap.

| Area | Capability | Owner / evidence |
|---|---|---|
| Public web | Localized English/Arabic entry page, RTL/LTR, theme and language switching | `apps/web/src/app/[locale]/`, `apps/web/messages/` |
| Authentication | Email/password sign-up and sign-in, email verification, password reset, optional Google OAuth, sign-out | `apps/backend/src/core/auth/`, `apps/platform/src/features/auth/` |
| Sessions | Session listing/revocation and server-derived country/city metadata | `apps/backend/src/core/auth/`, `apps/backend/src/core/geoip/`, Platform user settings |
| User lifecycle | Reversible account deactivation/restoration; no public hard delete | `account-lifecycle.service.ts`, Platform administration |
| Platform administration | User listing, role changes, credential takeover boundary, deactivate/restore actions | `apps/platform/src/features/admin/`, auth lifecycle controllers/services |
| Organizations | Create/switch organizations, overview/settings, membership and invitation management, archive/restore | `apps/platform/src/features/organization/`, Better Auth organization integration |
| Authorization | Separate platform (`user`, `admin`, `super_admin`) and organization (`member`, `admin`, `owner`) domains | `apps/backend/src/core/auth/permissions.ts`, Platform permission gates |
| Mail | Log, SMTP, Resend, or SES transports with localized verification/reset/invitation content | `apps/backend/src/core/mail/`, `apps/backend/src/core/auth/auth-mail.ts` |
| Async work | PostgreSQL transactional outbox feeding BullMQ workers with lease/retry/idempotency contracts | `apps/backend/src/core/outbox/`, `apps/backend/src/core/queue/` |
| Agent foundation | Internal durable AgentRun acceptance and duplicate-safe background execution through a replaceable Mastra boundary, with runs pinned to an exact agent definition version, terminal transport failures reconciled to a durable outcome, and deterministic configuration failures recorded as final; no public execution API or production agent definition yet | `apps/backend/src/agents/`, `apps/backend/prisma/schema.prisma` |
| Control plane | Code-registered feature flags with organization-over-platform-over-default precedence, Zod-validated bounded runtime settings, and AES-256-GCM provider credentials that no read surface returns; all super-admin only and evaluated authoritatively in the backend, with a Platform operator surface for all three | `apps/backend/src/control-plane/`, `apps/platform/src/features/control-plane/` |
| Abuse control | Redis sliding-window limits for Nest routes and PostgreSQL-backed Better Auth limits | `apps/backend/src/core/rate-limit/`, auth configuration |
| Operability | Liveness/readiness, graceful shutdown, structured logging, request IDs, optional OpenAPI | `apps/backend/src/core/health/`, `lifecycle/`, `providers/`, `docs/` |
| Delivery | Immutable multi-image publishing, migration-gated automatic Staging CD, prepared exact-evidence Production promotion | `.github/workflows/`, `ops/lightsail/` |
| Recovery | Exact release manifests, application rollback, verified logical-backup and isolated restore-drill tooling | `ops/lightsail/ai-agent-deploy`, `ops/backup/` |

The public web application is currently a compact product surface. The Vite
Platform contains the operational product flows. Backend enforcement remains
authoritative when a client-side permission gate exists.
