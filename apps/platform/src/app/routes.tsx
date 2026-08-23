import { DEFAULT_LOCALE } from '@repo/i18n-core';
import { redirect, type RouteObject } from 'react-router';

import {
  guestLoader,
  protectedLoader,
  PROTECTED_ROUTE_ID,
} from '@/features/auth/loaders';
import {
  AUTH_ROUTES,
  INVITATION_ROUTE,
  PLATFORM_ROUTES,
} from '@/features/auth/routes';
import {
  invitationLoader,
  organizationLoader,
  organizationsLoader,
  ORGANIZATION_ROUTE_ID,
} from '@/features/organization/loaders';
import { localizedPath } from '@/i18n/routing';
import { LocaleRoute, localeLoader } from '@/routes/locale-route';
import { RouteError, RouteErrorBoundary } from '@/routes/route-error';
import { RouteFallback } from '@/routes/route-fallback';

/**
 * The route tree.
 *
 * Paths here are relative to the router's `basename` (`/platform`), so what is
 * written below is what the reader sees after that prefix. Read top to bottom,
 * the tree is the application's access policy:
 *
 *   /:locale
 *     ├── (auth layout, public)
 *     │     sign-in · sign-up · verify-email · forgot-password
 *     │     reset-password · organizations/accept-invitation
 *     └── (protected: one loader, one boundary)
 *           └── (dashboard shell: sidebar + header)
 *                 dashboard · organizations · design-system
 *
 * Private by placement. A route added inside the protected branch is protected
 * before anybody writes a line of it; making something public means moving it
 * out, which is a visible change in a diff rather than a forgotten guard.
 *
 * The protected branch is a **pathless** route — it contributes a loader and
 * nothing to the URL. That is the whole mechanism: React Router runs a
 * pathless parent's loader before creating any of its children's elements, so
 * a redirect thrown there aborts the navigation with nothing rendered.
 *
 * Loaders are imported eagerly and components lazily, and that split is the
 * point rather than an oversight: a loader has to run *before* its route's
 * chunk is worth fetching, and the authentication guard must never wait on a
 * download. The two branches are separate chunks because a reader needs one or
 * the other — the sign-in screens or the dashboard — never both in a session.
 */

/** Route constants are absolute (`/sign-in`); child route paths are relative. */
const rel = (path: string) => path.replace(/^\//, '');

/** One chunk for the public authentication screens. */
const authModule = () => import('@/routes/auth/auth-routes');

/** One chunk for everything under an organization. */
const organizationModule = () =>
  import('@/routes/organizations/organization-routes');

/**
 * Builds the route tree.
 *
 * A function rather than a constant because React Router *mutates* the objects
 * it is given — assigning ids, and clearing `lazy` entries once they resolve.
 * A shared array would therefore carry one router's resolution state into the
 * next, which is invisible in an application that creates exactly one router
 * and immediate in a test file that creates a dozen.
 */
export function createRoutes(): RouteObject[] {
  return [
    {
      path: '/',
      errorElement: <RouteErrorBoundary />,
      HydrateFallback: RouteFallback,
      children: [
        // Bare `/platform`: nobody said which language, so the default one.
        {
          index: true,
          loader: () => redirect(localizedPath(DEFAULT_LOCALE, '/')),
        },

        {
          path: ':locale',
          loader: localeLoader,
          Component: LocaleRoute,
          children: [
            {
              /*
               * Everything below reports its failures in the reader's own
               * language: this boundary renders inside `LocaleRoute`, so the
               * dictionary is already mounted around it. The root boundary
               * above is only for the failures that happen before that —
               * including a dictionary that would not load.
               */
              errorElement: <RouteError />,
              children: [
                /* ---------------- public ---------------- */
                {
                  lazy: {
                    Component: async () =>
                      (await import('@/routes/auth/auth-layout')).AuthLayout,
                  },
                  children: [
                    {
                      path: rel(AUTH_ROUTES.signIn),
                      loader: guestLoader,
                      lazy: {
                        Component: async () => (await authModule()).SignInRoute,
                      },
                    },
                    {
                      path: rel(AUTH_ROUTES.signUp),
                      loader: guestLoader,
                      lazy: {
                        Component: async () => (await authModule()).SignUpRoute,
                      },
                    },
                    {
                      path: rel(AUTH_ROUTES.verifyEmail),
                      lazy: {
                        Component: async () =>
                          (await authModule()).VerifyEmailRoute,
                      },
                    },
                    {
                      path: rel(AUTH_ROUTES.forgotPassword),
                      lazy: {
                        Component: async () =>
                          (await authModule()).ForgotPasswordRoute,
                      },
                    },
                    {
                      path: rel(AUTH_ROUTES.resetPassword),
                      lazy: {
                        Component: async () =>
                          (await authModule()).ResetPasswordRoute,
                      },
                    },
                    {
                      // Public, but not open: the backend describes an invitation
                      // only to its recipient. Kept outside the dashboard because
                      // the reader may still need to create an account.
                      path: rel(INVITATION_ROUTE),
                      loader: invitationLoader,
                      lazy: {
                        Component: async () =>
                          (
                            await import('@/routes/auth/accept-invitation-route')
                          ).AcceptInvitationRoute,
                      },
                    },
                  ],
                },

                /* ---------------- private ---------------- */
                {
                  id: PROTECTED_ROUTE_ID,
                  loader: protectedLoader,
                  // Re-check the session when the page changes, but not for a mere
                  // query-string edit. The default would skip a same-path search
                  // change too, and a private tree should confirm on navigation.
                  shouldRevalidate: ({
                    currentUrl,
                    nextUrl,
                    defaultShouldRevalidate,
                  }) =>
                    defaultShouldRevalidate ||
                    currentUrl.pathname !== nextUrl.pathname,
                  children: [
                    {
                      lazy: {
                        Component: async () =>
                          (
                            await import('@/features/platform-shell/platform-shell')
                          ).PlatformShell,
                      },
                      children: [
                        {
                          index: true,
                          loader: organizationsLoader,
                          lazy: {
                            Component: async () =>
                              (
                                await import('@/routes/dashboard/dashboard-route')
                              ).DashboardRoute,
                          },
                        },

                        {
                          path: rel(PLATFORM_ROUTES.organizations),
                          children: [
                            {
                              index: true,
                              loader: organizationsLoader,
                              lazy: {
                                Component: async () =>
                                  (await organizationModule())
                                    .OrganizationsRoute,
                              },
                            },
                            {
                              // Before `:organizationId`, so `new` is a page and not
                              // an organization whose id happens to be "new".
                              path: 'new',
                              lazy: {
                                Component: async () =>
                                  (await organizationModule())
                                    .NewOrganizationRoute,
                              },
                            },
                            {
                              id: ORGANIZATION_ROUTE_ID,
                              path: ':organizationId',
                              loader: organizationLoader,
                              lazy: {
                                Component: async () =>
                                  (await organizationModule())
                                    .OrganizationRoute,
                              },
                              children: [
                                {
                                  index: true,
                                  lazy: {
                                    Component: async () =>
                                      (await organizationModule())
                                        .OrganizationOverviewRoute,
                                  },
                                },
                                {
                                  path: 'members',
                                  lazy: {
                                    Component: async () =>
                                      (await organizationModule())
                                        .OrganizationMembersRoute,
                                  },
                                },
                                {
                                  path: 'invitations',
                                  lazy: {
                                    Component: async () =>
                                      (await organizationModule())
                                        .OrganizationInvitationsRoute,
                                  },
                                },
                                {
                                  path: 'knowledge',
                                  lazy: {
                                    Component: async () =>
                                      (await organizationModule())
                                        .OrganizationKnowledgeRoute,
                                  },
                                },
                                {
                                  path: 'settings',
                                  lazy: {
                                    Component: async () =>
                                      (await organizationModule())
                                        .OrganizationSettingsRoute,
                                  },
                                },
                              ],
                            },
                          ],
                        },

                        {
                          path: rel(PLATFORM_ROUTES.userSettings),
                          lazy: {
                            Component: async () =>
                              (
                                await import('@/routes/settings/user-settings-route')
                              ).UserSettingsRoute,
                          },
                        },

                        {
                          path: rel(PLATFORM_ROUTES.adminUsers),
                          lazy: {
                            Component: async () =>
                              (
                                await import('@/routes/admin/admin-users-route')
                              ).AdminUsersRoute,
                          },
                        },

                        {
                          // Its own chunk: the operator surface is reached by
                          // one role, rarely, and nothing else in the shell
                          // needs the three panels it pulls in.
                          path: rel(PLATFORM_ROUTES.controlPlane),
                          lazy: {
                            Component: async () =>
                              (
                                await import('@/routes/admin/control-plane-route')
                              ).ControlPlaneRoute,
                          },
                        },

                        {
                          // The heaviest page in the application and the least
                          // visited, so it is the one that earns its own chunk.
                          path: rel(PLATFORM_ROUTES.designSystem),
                          lazy: {
                            Component: async () =>
                              (
                                await import('@/routes/dashboard/design-system-page')
                              ).DesignSystemPage,
                          },
                        },
                      ],
                    },
                  ],
                },

                // Inside a valid locale, but no route matched.
                { path: '*', loader: notFound },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** A real 404, so the boundary can tell it apart from a crash. */
function notFound(): never {
  throw new Response(null, { status: 404 });
}
