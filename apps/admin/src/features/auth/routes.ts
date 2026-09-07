/**
 * The whole route surface. There is no account creation route, and there is
 * not going to be one: staff are provisioned through the existing account
 * administration, never through this workspace.
 */
export const ADMIN_ROUTES = {
  workspace: '/',
  signIn: '/login',
  forbidden: '/forbidden',
} as const;
