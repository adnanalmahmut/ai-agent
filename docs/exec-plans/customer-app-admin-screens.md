# Administrative screens in the customer app

A route inventory taken while renaming `apps/platform` to `apps/app`, so RF-20
and RF-21 have a written starting point instead of re-deriving one. It records
what exists today; nothing here has moved.

Routes are as the application declares them in
`apps/app/src/features/auth/routes.ts`, under the `/platform` base path that
this phase keeps.

## Platform administration — leaves the customer app

Both screens are gated on a global permission and administer the deployment
rather than a tenant, which is why they are the ones that leave.

| Route | Responsibility | Destination |
| --- | --- | --- |
| `/admin/users` | Platform-wide account administration: listing accounts, role assignment, deactivation and restore (`src/features/admin/`) | RF-20 |
| `/admin/control-plane` | Feature flags, runtime settings, managed secrets and administrative audit history (`src/features/control-plane/`) | RF-21 |

`/admin/control-plane` is one page composed of four panels — feature flags,
runtime settings, managed secrets, audit — and the split between RF-20 and
RF-21 follows that responsibility line, not the URL: accounts move with RF-20,
configuration, secrets and audit with RF-21.

## Organization administration — stays

Organization-scoped screens administer a tenant, and the organization in the
path is the authority scope. They belong to the customer surface and are not
RF-20 or RF-21 work.

| Route | Responsibility |
| --- | --- |
| `/organizations/[organizationId]/members` | Membership and organization role assignment |
| `/organizations/[organizationId]/invitations` | Invitation lifecycle |
| `/organizations/[organizationId]/settings` | Organization settings, archive and restore |
| `/settings` | The signed-in person's own account settings |

## Not a product surface

`/design-system` is a developer-facing token and component showcase. It is
neither customer nor administrative, and its disposition is open.

## Constraints any move inherits

- Platform roles and organization roles are separate domains; a move must not
  merge them.
- Client permission gates are presentation only. Backend authorization stays
  decisive, so removing a screen removes no check.
- Account deactivation and organization archival are reversible operations.
  Neither has a hard delete, and neither may acquire one in a move.
