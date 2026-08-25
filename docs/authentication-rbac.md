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
| Organization | `member`, `admin`, `owner` | membership, invitations, organization update/archive/restore, knowledge read/write |

`knowledge` is the one organization resource Better Auth knows nothing about,
so it is added rather than narrowed. Reading is ordinary membership — a member
who cannot see the material cannot tell why an agent answered as it did — while
writing belongs to `admin` and `owner`. It is enforced by a guard that runs
before body validation and authorizes against the organization named in the
path, not the session's active one.

No global role grants organization authority and no organization role grants
platform authority. `super_admin` alone can grant roles, take over account
credentials, deactivate/restore accounts, and recover archived organizations.
Organization `owner` controls its own archive lifecycle. No role receives hard
user or organization deletion.

Because `super_admin` alone can grant roles, the first one cannot be granted. It
is created out-of-band by the `super-admin:create` operator command, which
refuses while any super administrator exists — including a deactivated or banned
one, so the gate cannot be reopened by removing the incumbent.

That condition is not a security boundary on its own: a super administrator can
demote the last super administrator and reopen it. **The command's real trust
boundary is host access.** Anyone who can run it can already read `DATABASE_URL`
and write the role column directly, which is why it is excluded from the
deployment key's forced-command allowlist and available only to local root.

It goes through Better Auth's own admin endpoint so the account it writes uses
the same password hashing, the same `credential` provider linkage, and the same
validated role catalogue as one created through the API. That endpoint, invoked
in-process with neither a request nor headers, **skips the `user:create`,
`user:set-role` and `user:ban` permission checks entirely** — which is what makes
it usable before any session can exist, and what makes it unsafe anywhere else.
Calling it from a request-handling service without forwarding headers would mint
a super administrator with no authorization at all. An ESLint rule confines it to
the CLI composition root. Password length is enforced by the command itself,
reading the configured policy, because that endpoint does not enforce it.

See [`docs/operations-runbook.md`](operations-runbook.md).

Better Auth routes use their own database limiter because they bypass Nest's
generic interceptor. Canonical IP comes only from the Nginx-overwritten
`x-real-ip` header. Session `country`/`city` are declared server-only fields and
browser input is ignored.
