import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  MemberHasPermission,
  Session,
  UserHasPermission,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import { createZodDto } from '../http';
import { AccountLifecycleService } from './account-lifecycle.service';
import { OrganizationLifecycleService } from './organization-lifecycle.service';

/**
 * Account and organization lifecycle.
 *
 * These are application operations, not authentication protocol, so they live
 * on application routes behind the normal Nest pipeline: `ZodValidationPipe`
 * validates them, `UnifiedExceptionFilter` localizes their failures, and they
 * appear in the application's own OpenAPI document. Better Auth's native
 * responses on `/api/auth/*` stay native and untouched.
 *
 * The controllers are deliberately thin: authorization is a decorator, the
 * work is a service call. No transaction, no Prisma, no lifecycle rule here.
 */

const reasonSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

class LifecycleReasonDto extends createZodDto(reasonSchema) {}

@ApiTags('Account lifecycle')
@Controller('admin/users')
export class AccountLifecycleController {
  constructor(private readonly accounts: AccountLifecycleService) {}

  /**
   * `accountLifecycle:deactivate` — held only by `super_admin`.
   *
   * Note what this is *not*: Better Auth's `POST /api/auth/admin/remove-user`
   * requires `user:["delete"]`, which no role in this application is granted.
   * Hard deletion is unavailable to everyone; this is the reversible operation
   * that replaces it.
   */
  @Post(':userId/deactivate')
  @UserHasPermission({ permissions: { accountLifecycle: ['deactivate'] } })
  @ApiOperation({
    operationId: 'deactivateUserAccount',
    summary: 'Deactivate a user account (reversible soft delete)',
  })
  @ApiParam({ name: 'userId', description: 'Id of the account to deactivate' })
  @ApiBody({ required: false, schema: { type: 'object' } })
  deactivate(
    @Param('userId') userId: string,
    @Body() body: LifecycleReasonDto,
    @Session() session: UserSession,
  ) {
    return this.accounts.deactivate({
      userId,
      actorUserId: session.user.id,
      reason: body?.reason,
    });
  }

  /** `accountLifecycle:restore` — held only by `super_admin`. */
  @Post(':userId/restore')
  @UserHasPermission({ permissions: { accountLifecycle: ['restore'] } })
  @ApiOperation({
    operationId: 'restoreUserAccount',
    summary: 'Restore a deactivated user account',
  })
  @ApiParam({ name: 'userId', description: 'Id of the account to restore' })
  restore(@Param('userId') userId: string) {
    return this.accounts.restore({ userId });
  }
}

@ApiTags('Account lifecycle')
@Controller('user/account')
export class SelfAccountLifecycleController {
  constructor(private readonly accounts: AccountLifecycleService) {}

  /**
   * Deactivate own user account (reversible soft delete).
   *
   * Available to any authenticated user. Operates strictly on the caller's
   * session identity without accepting a user ID parameter from the client.
   */
  @Post('deactivate')
  @ApiOperation({
    operationId: 'deactivateSelfAccount',
    summary: 'Deactivate own user account',
  })
  @ApiBody({ required: false, schema: { type: 'object' } })
  deactivateSelf(
    @Body() body: LifecycleReasonDto,
    @Session() session: UserSession,
  ) {
    return this.accounts.deactivate({
      userId: session.user.id,
      actorUserId: session.user.id,
      reason: body?.reason,
    });
  }
}

@ApiTags('Organization lifecycle')
@Controller('organizations')
export class OrganizationLifecycleController {
  constructor(private readonly organizations: OrganizationLifecycleService) {}

  /**
   * The archived organizations this caller could restore.
   *
   * `@MemberHasPermission` cannot guard this one: that decorator authorizes
   * against a *single* organization through Better Auth's own
   * `/organization/has-permission`, which the archived-organization hook
   * refuses by design. This route asks a different question — "which of them,
   * if any" — and the service answers it against the same role definitions.
   *
   * Every authenticated user may call it. What varies is the answer, and an
   * empty list is the honest one for somebody with nothing to restore.
   */
  @Get('archived')
  @ApiOperation({
    operationId: 'listRestorableArchivedOrganizations',
    summary: 'List archived organizations the caller may restore',
  })
  listArchived(@Session() session: UserSession) {
    return this.organizations.listRestorableArchived({
      actorUserId: session.user.id,
      actorGlobalRole: globalRoleOf(session),
    });
  }

  /**
   * Archiving is authorized the ordinary way, because the organization is
   * still active at the moment of the call: `@MemberHasPermission` resolves
   * the member row through Better Auth and evaluates `organization:archive`,
   * which only `owner` holds.
   *
   * `@RequireActiveOrg` is deliberately absent — it would prove only that
   * *some* organization is selected, which says nothing about this one.
   */
  @Post(':organizationId/archive')
  @MemberHasPermission({ permissions: { organization: ['archive'] } })
  @ApiOperation({
    operationId: 'archiveOrganization',
    summary: 'Archive an organization (reversible; nothing is deleted)',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization to archive' })
  @ApiBody({ required: false, schema: { type: 'object' } })
  async archive(
    @Param('organizationId') organizationId: string,
    @Body() body: LifecycleReasonDto,
    @Session() session: UserSession,
  ) {
    // `@MemberHasPermission` authorizes against the session's *active*
    // organization. This re-checks the one actually named in the path, so a
    // member of organization A cannot archive organization B by keeping A
    // selected.
    await this.organizations.assertMayPerform({
      organizationId,
      actorUserId: session.user.id,
      actorGlobalRole: globalRoleOf(session),
      organizationPermission: 'archive',
    });

    return this.organizations.archive({
      organizationId,
      actorUserId: session.user.id,
      reason: body?.reason,
    });
  }

  /**
   * Restore has no `@MemberHasPermission`, and that is not an omission.
   *
   * That decorator authorizes through `/organization/has-permission`, which
   * the archived-organization hook refuses for an archived organization —
   * correctly, since every other operation on one must be refused. So the
   * check happens in the service instead, against the *same* role
   * definitions, via an authoritative member read. Two legitimate callers:
   * an `owner` with `organization:restore`, or a `super_admin` with the global
   * `organizationLifecycle:restore`, which grants nothing else in the
   * organization.
   */
  @Post(':organizationId/restore')
  @ApiOperation({
    operationId: 'restoreOrganization',
    summary: 'Restore an archived organization',
  })
  @ApiParam({ name: 'organizationId', description: 'Organization to restore' })
  async restore(
    @Param('organizationId') organizationId: string,
    @Session() session: UserSession,
  ) {
    await this.organizations.assertMayPerform({
      organizationId,
      actorUserId: session.user.id,
      actorGlobalRole: globalRoleOf(session),
      organizationPermission: 'restore',
      globalPermission: 'restore',
    });

    return this.organizations.restore({ organizationId });
  }
}

/**
 * Normalises the session's global role to a string.
 *
 * Reading it is not the authorization decision — the service evaluates it
 * against the access-control definitions. There is no role-name comparison
 * anywhere on this path.
 */
function globalRoleOf(session: UserSession): string | null {
  const role = session.user.role;
  if (Array.isArray(role)) return role.join(',');
  return typeof role === 'string' ? role : null;
}
