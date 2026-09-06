import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  MemberHasPermission,
  Session,
  UserHasPermission,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { apiSuccessSchema, createZodDto, wireSchemaOf } from '../http';
import {
  accountLifecycleReasonSchema,
  accountLifecycleResultSchema,
} from './account-lifecycle.contract';
import { AccountLifecycleService } from './account-lifecycle.service';
import { OrganizationLifecycleService } from './organization-lifecycle.service';

const reasonSchema = accountLifecycleReasonSchema;

class LifecycleReasonDto extends createZodDto(reasonSchema) {}

const accountResponse = {
  schema: apiSuccessSchema(accountLifecycleResultSchema),
};

@ApiTags('Account lifecycle')
@Controller('admin/users')
export class AccountLifecycleController {
  constructor(private readonly accounts: AccountLifecycleService) {}

  @Post(':userId/deactivate')
  @UserHasPermission({ permissions: { accountLifecycle: ['deactivate'] } })
  @ApiOperation({
    operationId: 'deactivateUserAccount',
    summary: 'Deactivate a user account (reversible soft delete)',
  })
  @ApiParam({ name: 'userId', description: 'Id of the account to deactivate' })
  // The body is optional, but when one is sent it is the schema that already
  // validates it — not an empty object, which generated as `Record<string,
  // never>` and told a client it could send nothing.
  @ApiBody({ required: false, schema: wireSchemaOf(reasonSchema) })
  @ApiCreatedResponse(accountResponse)
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

  @Post(':userId/restore')
  @UserHasPermission({ permissions: { accountLifecycle: ['restore'] } })
  @ApiOperation({
    operationId: 'restoreUserAccount',
    summary: 'Restore a deactivated user account',
  })
  @ApiParam({ name: 'userId', description: 'Id of the account to restore' })
  @ApiCreatedResponse(accountResponse)
  restore(@Param('userId') userId: string) {
    return this.accounts.restore({ userId });
  }
}

@ApiTags('Account lifecycle')
@Controller('user/account')
export class SelfAccountLifecycleController {
  constructor(private readonly accounts: AccountLifecycleService) {}

  @Post('deactivate')
  @ApiOperation({
    operationId: 'deactivateSelfAccount',
    summary: 'Deactivate own user account',
  })
  // The body is optional, but when one is sent it is the schema that already
  // validates it — not an empty object, which generated as `Record<string,
  // never>` and told a client it could send nothing.
  @ApiBody({ required: false, schema: wireSchemaOf(reasonSchema) })
  @ApiCreatedResponse(accountResponse)
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

function globalRoleOf(session: UserSession): string | null {
  const role = session.user.role;
  if (Array.isArray(role)) return role.join(',');
  return typeof role === 'string' ? role : null;
}
