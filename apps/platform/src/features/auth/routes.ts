export const AUTH_ROUTES = {
  signIn: '/sign-in',
  signUp: '/sign-up',
  verifyEmail: '/verify-email',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
} as const;

export const PLATFORM_ROUTES = {
  dashboard: '/',
  organizations: '/organizations',
  newOrganization: '/organizations/new',
  userSettings: '/settings',
  adminUsers: '/admin/users',
  controlPlane: '/admin/control-plane',
  designSystem: '/design-system',
} as const;

export const ORGANIZATION_ROUTES = {
  overview: (id: string) => `/organizations/${encodeURIComponent(id)}`,
  members: (id: string) => `/organizations/${encodeURIComponent(id)}/members`,
  invitations: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/invitations`,
  knowledge: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/knowledge`,
  contentIdeas: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/content-ideas`,
  contentProjects: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/content-projects`,
  approvals: (id: string) =>
    `/organizations/${encodeURIComponent(id)}/approvals`,
  settings: (id: string) => `/organizations/${encodeURIComponent(id)}/settings`,
} as const;

export const ORGANIZATION_DETAIL_ROUTES = {
  contentProject: (id: string, projectId: string) =>
    `${ORGANIZATION_ROUTES.contentProjects(id)}/${encodeURIComponent(projectId)}`,
} as const;

export const INVITATION_ROUTE = '/organizations/accept-invitation';
export const INVITATION_ID_PARAM = 'id';

export const RETURN_TO_PARAM = 'returnTo';

export const AUTHENTICATION_ONLY_PATHS: readonly string[] =
  Object.values(AUTH_ROUTES);

export const GUEST_ONLY_PATHS: readonly string[] = [
  AUTH_ROUTES.signIn,
  AUTH_ROUTES.signUp,
];

export const PUBLIC_PATHS: readonly string[] = [
  ...AUTHENTICATION_ONLY_PATHS,
  INVITATION_ROUTE,
];

export function matchesPath(
  pathname: string,
  candidates: readonly string[],
): boolean {
  return candidates.some(
    (candidate) =>
      pathname === candidate || pathname.startsWith(`${candidate}/`),
  );
}
