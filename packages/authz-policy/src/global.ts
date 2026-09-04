import type { RoleGrants } from './statements';

/**
 * Platform-wide authority: what an account may do to the installation itself.
 *
 * Only the statements this application owns live here. `user` and `session`
 * come from Better Auth's admin plugin, and each consumer spreads its own
 * installed `defaultStatements` so the catalogue always tracks the plugin
 * version it is enforcing against rather than a copy that can fall behind.
 */
export const GLOBAL_APPLICATION_STATEMENTS = {
  accountLifecycle: ['deactivate', 'restore'],

  organizationLifecycle: ['restore'],

  controlPlane: ['read', 'write'],
  managedSecret: ['write'],
} as const;

/**
 * The `user` and `session` actions are Better Auth's vocabulary, so they are
 * checked where the role is built: both consumers pass these grants to
 * `newRole`, which validates every action against the composed catalogue.
 */
type GlobalRoleGrants = RoleGrants<typeof GLOBAL_APPLICATION_STATEMENTS> & {
  readonly user: readonly string[];
  readonly session: readonly string[];
};

// Key order is public: the platform derives its assignable-role list from it.
export const GLOBAL_ROLE_GRANTS = {
  user: {
    user: [],
    session: [],
    accountLifecycle: [],
    organizationLifecycle: [],
    controlPlane: [],
    managedSecret: [],
  },

  admin: {
    user: [
      'get',
      'list',
      'create',
      'update',
      // Reversible, and needed for routine moderation.
      'ban',
      // Support workflow. Impersonating another *admin* additionally requires
      // `impersonate-admins`, which only `super_admin` holds.
      'impersonate',
    ],
    session: ['list', 'revoke', 'delete'],
    accountLifecycle: [],
    organizationLifecycle: [],
    controlPlane: [],
    managedSecret: [],
  },

  super_admin: {
    user: [
      'get',
      'list',
      'create',
      'update',
      'ban',
      'impersonate',
      'impersonate-admins',
      'set-role',
      'set-password',
      'set-email',
    ],
    session: ['list', 'revoke', 'delete'],
    accountLifecycle: ['deactivate', 'restore'],
    organizationLifecycle: ['restore'],
    controlPlane: ['read', 'write'],
    managedSecret: ['write'],
  },
} as const satisfies Record<string, GlobalRoleGrants>;

export type GlobalRoleName = keyof typeof GLOBAL_ROLE_GRANTS;
