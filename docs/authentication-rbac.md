# Authentication and RBAC

Better Auth uses the Prisma adapter with email/password, optional Google OAuth,
email verification, password reset, admin, and organization plugins. OAuth
tokens are encrypted. Session cookies use the `__Host-` prefix in deployed
environments.

Users are deactivated and organizations archived; no application role receives
hard-delete authority.

## Separate authorization domains

Platform and organization permissions use separate Better Auth access-control
instances. A role in one domain grants nothing in the other.

| Domain       | Roles                          | Scope                                                     |
| ------------ | ------------------------------ | --------------------------------------------------------- |
| Platform     | `user`, `admin`, `super_admin` | accounts, sessions, platform lifecycle, and control plane |
| Organization | `member`, `admin`, `owner`     | membership and tenant-owned product data                  |

Platform `admin` handles routine account and session operations.
`super_admin` alone may grant roles, take over credentials, deactivate or
restore accounts, restore archived organizations, or change control-plane
configuration and managed credentials.

Organization members can read shared knowledge, content results/projects, and
pending agent actions. Organization admins and owners can manage membership,
invitations, knowledge, content creation, approvals, agent installation, and MCP
sessions. Only owners may archive or restore their organization. The permission
catalog in `apps/backend/src/infrastructure/auth/permissions.ts` is
authoritative.

Application organization routes use one shared guard before body validation.
The guard authorizes against the organization in the path, not the session's
active-organization hint. MCP routes additionally bind a session to the member
who opened it; an organization admin or owner may close another member's
session to recover capacity.

## Bootstrap and account safety

The first `super_admin` is created through the host-authorized
`super-admin:create` command. It refuses if any super-administrator account
exists, including a deactivated or banned one. The command is confined to its
CLI composition root and is excluded from the deployment key's allowed
commands.

Normal application mutations cannot leave zero usable super administrators.
Lifecycle hooks and a PostgreSQL advisory-lock trigger enforce that invariant
across concurrent changes.

## Request boundaries

Better Auth native routes use their own database rate limiter because they do
not pass through Nest's general rate-limit interceptor. Canonical client IP
comes from Nginx's overwritten `X-Real-IP` header. Session country and city
are derived server-side from that address; request bodies cannot set them.

Client-side permission checks only decide what controls to render. Every
mutation and protected read is authorized again by the backend.
