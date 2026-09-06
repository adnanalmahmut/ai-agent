import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';

import { isAppLocale } from '@repo/i18n-core';
import type { PrismaService } from '../database';
import type { GeoIpService } from '../geoip';
import {
  lastSuperAdminApiError,
  wouldEmptySuperAdmins,
  type SuperAdminFloorEffect,
} from './super-admin-floor';
import { SUPER_ADMIN_ROLE } from './permissions';

export const ACCOUNT_DEACTIVATED_CODE = 'ACCOUNT_DEACTIVATED';
export const ORGANIZATION_ARCHIVED_CODE = 'ORGANIZATION_ARCHIVED';

const ACCOUNT_DEACTIVATED_MESSAGE =
  'This account has been deactivated. Contact support if you believe this is an error.';
const ORGANIZATION_ARCHIVED_MESSAGE =
  'This organization is archived and cannot be used until it is restored.';

export function createSessionDatabaseHooks(
  prisma: PrismaService,
  geoIp: Pick<GeoIpService, 'lookup'>,
) {
  return {
    session: {
      create: {
        before: async (session: {
          userId: string;
          ipAddress?: string | null;
          [field: string]: unknown;
        }) => {
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

          const location = await geoIp.lookup(session.ipAddress);
          return {
            data: {
              ...session,
              country: location.country,
              city: location.city,
            },
          };
        },
      },
    },
  };
}

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

export function createArchivedOrganizationHook(prisma: PrismaService) {
  return createAuthMiddleware(async (ctx) => {
    const hook = ctx as unknown as HookContext;

    const fields = GUARDED_ORGANIZATION_PATHS[hook.path];
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
  // Invitation acceptance must recheck the invitation's current organization.
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

  // Session-selected operations still recheck archive state.
  const session = (await getSessionFromCtx(ctx).catch(() => null)) as {
    session?: { activeOrganizationId?: string | null };
  } | null;

  return session?.session?.activeOrganizationId ?? undefined;
}

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

export const SUPER_ADMIN_GUARDED_PATHS: Record<string, SuperAdminFloorEffect> =
  {
    '/admin/set-role': 'roleChange',
    '/admin/ban-user': 'ban',
    '/admin/remove-user': 'delete',
    '/admin/update-user': 'roleChange',
  };

export function createSuperAdminFloorHook(prisma: PrismaService) {
  return createAuthMiddleware(async (ctx) => {
    const hook = ctx as unknown as HookContext;
    const effect = SUPER_ADMIN_GUARDED_PATHS[hook.path];

    if (effect === undefined) return;

    const userId =
      readStringField(hook.body, 'userId') ??
      readStringField(hook.query, 'userId');

    if (!userId) return;

    // Promotions must remain possible when only one super administrator exists.
    if (!leavesAccountUnusable(hook, effect)) return;

    if (await wouldEmptySuperAdmins(prisma, userId)) {
      throw lastSuperAdminApiError();
    }
  });
}

function leavesAccountUnusable(
  hook: HookContext,
  effect: SuperAdminFloorEffect,
): boolean {
  if (effect === 'ban' || effect === 'delete') return true;

  const body = (hook.body ?? {}) as Record<string, unknown>;
  const data = (body.data ?? body) as Record<string, unknown>;

  if (data.banned === true) return true;

  const role = data.role ?? body.role;

  if (role === undefined || role === null) return false;
  if (typeof role !== 'string' && !Array.isArray(role)) return false;

  const names = (Array.isArray(role) ? role : role.split(',')).map((name) =>
    typeof name === 'string' ? name.trim() : '',
  );

  return !names.includes(SUPER_ADMIN_ROLE);
}
