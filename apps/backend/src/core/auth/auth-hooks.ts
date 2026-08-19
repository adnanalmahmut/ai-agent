import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';

import { isAppLocale } from '@repo/i18n-core';
import type { PrismaService } from '../../database';

/**
 * The two lifecycle invariants Better Auth cannot enforce on its own.
 *
 * Both live here, and only here. The alternative — `if (user.deletedAt)` and
 * `if (organization.archivedAt)` sprinkled through controllers — would leave
 * Better Auth's own routes (`/organization/invite-member`,
 * `/sign-in/social`, …) unguarded, because those never pass through a Nest
 * controller at all.
 */

/** Machine-readable codes on the native Better Auth error body. */
export const ACCOUNT_DEACTIVATED_CODE = 'ACCOUNT_DEACTIVATED';
export const ORGANIZATION_ARCHIVED_CODE = 'ORGANIZATION_ARCHIVED';

const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account has been deactivated. Contact support if you believe this is an error.';
const ORGANIZATION_ARCHIVED_MESSAGE =
  'This organization is archived and cannot be used until it is restored.';

/**
 * Refuses to create a session for a deactivated account.
 *
 * `databaseHooks.session.create.before` is the right seam because *every*
 * sign-in path ends there: email/password, Google, and any provider added
 * later. Guarding the sign-in routes individually would leave the next
 * provider unguarded by default; guarding session creation cannot.
 *
 * Runs alongside — not instead of — the admin plugin's own ban check. Better
 * Auth collects plugin `databaseHooks` and root `databaseHooks` into one list
 * rather than letting the latter overwrite the former, so a banned *and*
 * deactivated user is refused by whichever fires first, and neither state
 * masks the other.
 */
export function createSoftDeleteDatabaseHooks(prisma: PrismaService) {
  return {
    session: {
      create: {
        before: async (session: { userId: string }) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { deletedAt: true },
          });

          if (user?.deletedAt) {
            throw new APIError('FORBIDDEN', {
              message: ACCOUNT_DEACTIVATED_MESSAGE,
              code: ACCOUNT_DEACTIVATED_CODE,
            });
          }
        },
      },
    },
  };
}

/**
 * Validates that preferredLanguage contains a supported locale on every
 * client-writable path (sign-up, update-user, etc.).
 *
 * Path-agnostic by design: `input: true` on the field schema makes it
 * writable on any endpoint Better Auth exposes, so validation must not
 * depend on which path the request hit.
 */
export function createPreferredLanguageValidationHook() {
  return createAuthMiddleware(async (ctx) => {
    await Promise.resolve();
    const hook = ctx as unknown as HookContext;
    const body = hook.body as Record<string, unknown> | undefined;
    if (
      body &&
      'preferredLanguage' in body &&
      body.preferredLanguage !== undefined &&
      body.preferredLanguage !== null
    ) {
      const lang =
        typeof body.preferredLanguage === 'string'
          ? body.preferredLanguage
          : '';
      if (!isAppLocale(lang)) {
        throw new APIError('BAD_REQUEST', {
          message: 'Unsupported preferred language',
          code: 'INVALID_PREFERRED_LANGUAGE',
        });
      }
    }
  });
}

/**
 * Organization endpoints guarded against an archived organization, and the
 * request field naming their target where there is one.
 *
 * An allow-list of *guarded* paths rather than a deny-list of exempt ones:
 * `/organization/create` cannot target an archived organization, and
 * `/organization/list` is filtered by the after-hook instead. A test asserts
 * this table against the plugin's live endpoint list, so a Better Auth
 * upgrade that adds an organization route fails the build rather than
 * silently escaping the guard.
 *
 * An empty array means "no explicit target; use the session's active
 * organization".
 */
export const GUARDED_ORGANIZATION_PATHS: Record<string, readonly string[]> = {
  '/organization/set-active': ['organizationId'],
  '/organization/update': ['organizationId'],
  '/organization/invite-member': ['organizationId'],
  '/organization/has-permission': ['organizationId'],
  '/organization/get-full-organization': ['organizationId'],
  '/organization/update-member-role': ['organizationId'],
  '/organization/remove-member': ['organizationId'],
  '/organization/leave': ['organizationId'],
  '/organization/list-members': ['organizationId'],
  '/organization/list-invitations': ['organizationId'],
  '/organization/accept-invitation': [],
  '/organization/cancel-invitation': [],
  '/organization/get-active-member': [],
  '/organization/get-active-member-role': [],
};

type HookContext = {
  path: string;
  body?: unknown;
  query?: unknown;
};

function readStringField(source: unknown, field: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Makes an archived organization operationally inert across every Better Auth
 * organization endpoint.
 *
 * This is `hooks.before`, whose matcher Better Auth hard-codes to `() => true`
 * — so it also runs for `auth.api.*` calls made from inside this process.
 * That is what closes the loop on *application* resources: the guard's
 * `@MemberHasPermission` reaches the database through `auth.api.hasPermission`
 * — i.e. `/organization/has-permission`, which is in the table above. One hook
 * therefore covers Better Auth's own routes and every application route that
 * authorizes against an organization, with no per-controller check anywhere.
 */
export function createArchivedOrganizationHook(prisma: PrismaService) {
  return createAuthMiddleware(async (ctx) => {
    const hook = ctx as unknown as HookContext;

    const fields = GUARDED_ORGANIZATION_PATHS[hook.path];
    // Not an organization endpoint. Costs one property lookup on every other
    // request, including the `getSession` the guard performs per request.
    if (!fields) return;

    const organizationId = await resolveTargetOrganizationId(
      prisma,
      hook,
      fields,
      ctx,
    );
    if (!organizationId) return;

    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { archivedAt: true },
    });

    if (organization?.archivedAt) {
      throw new APIError('FORBIDDEN', {
        message: ORGANIZATION_ARCHIVED_MESSAGE,
        code: ORGANIZATION_ARCHIVED_CODE,
      });
    }
  });
}

async function resolveTargetOrganizationId(
  prisma: PrismaService,
  hook: HookContext,
  fields: readonly string[],
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<string | undefined> {
  // Accepting an invitation names the invitation, not the organization. The
  // organization has to be read from it, or an invitation issued *before* the
  // archive would still let someone join an archived organization.
  if (hook.path === '/organization/accept-invitation') {
    const invitationId = readStringField(hook.body, 'invitationId');
    if (!invitationId) return undefined;

    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { organizationId: true },
    });

    return invitation?.organizationId;
  }

  if (hook.path === '/organization/cancel-invitation') {
    const invitationId = readStringField(hook.body, 'invitationId');
    if (invitationId) {
      const invitation = await prisma.invitation.findUnique({
        where: { id: invitationId },
        select: { organizationId: true },
      });
      if (invitation) return invitation.organizationId;
    }
  }

  for (const field of fields) {
    const explicit =
      readStringField(hook.body, field) ?? readStringField(hook.query, field);
    if (explicit) return explicit;
  }

  // No explicit target: the endpoint operates on the session's selected
  // organization. That is the case that matters most — it is how a member who
  // is already signed in would otherwise keep working inside an organization
  // that was archived underneath them.
  //
  // `getSessionFromCtx` memoises onto `ctx.context.session`, which the
  // endpoint's own `sessionMiddleware` then reuses, so this does not add a
  // second session read to the request.
  const session = (await getSessionFromCtx(ctx).catch(() => null)) as {
    session?: { activeOrganizationId?: string | null };
  } | null;

  return session?.session?.activeOrganizationId ?? undefined;
}

/**
 * Hides archived organizations from `/organization/list`.
 *
 * Filtering the response rather than the query because the plugin builds that
 * query itself and exposes no `where` seam. The list is the only endpoint that
 * enumerates organizations without naming one, so it is the only place the
 * before-hook cannot reach.
 */
export function createArchivedOrganizationListFilter(prisma: PrismaService) {
  return createAuthMiddleware(async (ctx) => {
    const hook = ctx as unknown as HookContext;
    if (hook.path !== '/organization/list') return;

    const returned = (ctx.context as { returned?: unknown }).returned;
    const organizations = await readListResponse(returned);
    if (!organizations || organizations.length === 0) return;

    const archived = await prisma.organization.findMany({
      where: {
        id: { in: organizations.map((organization) => organization.id) },
        archivedAt: { not: null },
      },
      select: { id: true },
    });

    if (archived.length === 0) return;

    const archivedIds = new Set(
      archived.map((organization) => organization.id),
    );

    return ctx.json(
      organizations.filter((organization) => !archivedIds.has(organization.id)),
    );
  });
}

async function readListResponse(
  returned: unknown,
): Promise<{ id: string }[] | undefined> {
  if (!returned) return undefined;

  const body =
    returned instanceof Response
      ? returned.status === 200
        ? ((await returned.clone().json()) as unknown)
        : undefined
      : returned;

  return Array.isArray(body) ? (body as { id: string }[]) : undefined;
}
