# Authentication and RBAC

Better Auth 1.6.27 uses the Prisma adapter, email/password authentication,
optional Google OAuth, email verification, password reset, admin and
organization plugins. OAuth tokens are encrypted. Session cookies use the
`__Host-` prefix. User/organization lifecycle is reversible: users are
deactivated and organizations archived; hard deletion is not exposed.

There are two deliberately separate access-control domains:

| Domain | Roles | Authority |
|---|---|---|
| Platform | `user`, `admin`, `super_admin` | account/session administration and platform lifecycle |
| Organization | `member`, `admin`, `owner` | membership, invitations, organization update/archive/restore |

No global role grants organization authority and no organization role grants
platform authority. `super_admin` alone can grant roles, take over account
credentials, deactivate/restore accounts, and recover archived organizations.
Organization `owner` controls its own archive lifecycle. No role receives hard
user or organization deletion.

Better Auth routes use their own database limiter because they bypass Nest's
generic interceptor. Canonical IP comes only from the Nginx-overwritten
`x-real-ip` header. Session `country`/`city` are declared server-only fields and
browser input is ignored.
