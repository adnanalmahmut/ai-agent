import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  Session,
  UserHasPermission,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import { AppException } from '../../core/errors';
import { createZodDto } from '../../infrastructure/http';
import {
  CONTROL_PLANE_AUDIT_RESOURCES,
  ControlPlaneAuditService,
} from './audit/control-plane-audit.service';
import {
  FEATURE_FLAG_KEYS,
  type FeatureFlagKey,
  isFeatureFlagKey,
} from './feature-flags/feature-flag.registry';
import { FeatureFlagService } from './feature-flags/feature-flag.service';
import {
  MANAGED_SECRET_KEYS,
  type ManagedSecretKey,
  isManagedSecretKey,
} from './managed-secrets/managed-secret.registry';
import { ManagedSecretService } from './managed-secrets/managed-secret.service';
import {
  RUNTIME_SETTING_KEYS,
  type RuntimeSettingKey,
  isRuntimeSettingKey,
} from './runtime-settings/runtime-setting.registry';
import { RuntimeSettingService } from './runtime-settings/runtime-setting.service';

const enabledSchema = z.object({ enabled: z.boolean() }).strict();
class FeatureFlagOverrideDto extends createZodDto(enabledSchema) {}

const settingValueSchema = z
  .object({
    value: z.unknown(),
  })
  .strict();
class RuntimeSettingValueDto extends createZodDto(settingValueSchema) {}

const secretSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
class ManagedSecretDto extends createZodDto(secretSchema) {}

const auditQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
    resource: z.enum(CONTROL_PLANE_AUDIT_RESOURCES).optional(),
    resourceKey: z.string().trim().min(1).max(120).optional(),
    organizationId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
class AuditQueryDto extends createZodDto(auditQuerySchema) {}

function assertKnown<T extends string>(
  value: string,
  guard: (candidate: string) => candidate is T,
  resource: string,
): T {
  if (!guard(value)) {
    throw new AppException('NOT_FOUND', {
      context: { resource, requestedKey: value },
    });
  }

  return value;
}

@ApiTags('Control plane')
@Controller('platform/control-plane')
export class ControlPlaneController {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly settings: RuntimeSettingService,
    private readonly secrets: ManagedSecretService,
    private readonly audit: ControlPlaneAuditService,
  ) {}

  // --- Feature flags -------------------------------------------------------

  @Get('feature-flags')
  @UserHasPermission({ permissions: { controlPlane: ['read'] } })
  @ApiOperation({
    operationId: 'listFeatureFlags',
    summary: 'List every feature flag with its resolved platform value',
  })
  listFeatureFlags() {
    return this.flags.listAll();
  }

  @Get('feature-flags/organizations/:organizationId')
  @UserHasPermission({ permissions: { controlPlane: ['read'] } })
  @ApiOperation({
    operationId: 'listFeatureFlagsForOrganization',
    summary: 'List every feature flag as one organization resolves it',
  })
  @ApiParam({ name: 'organizationId' })
  listFeatureFlagsForOrganization(
    @Param('organizationId') organizationId: string,
  ) {
    return this.flags.listAll({ organizationId });
  }

  @Put('feature-flags/:key')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'setFeatureFlagPlatformOverride',
    summary: 'Set the platform-wide override for a feature flag',
  })
  @ApiParam({ name: 'key', enum: FEATURE_FLAG_KEYS })
  setFeatureFlag(
    @Param('key') key: string,
    @Body() body: FeatureFlagOverrideDto,
    @Session() session: UserSession,
  ) {
    return this.flags.setPlatformOverride({
      key: assertKnown<FeatureFlagKey>(key, isFeatureFlagKey, 'feature-flag'),
      enabled: body.enabled,
      actorUserId: session.user.id,
    });
  }

  @Delete('feature-flags/:key')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'clearFeatureFlagPlatformOverride',
    summary: 'Remove the platform override and fall back to the code default',
  })
  @ApiParam({ name: 'key', enum: FEATURE_FLAG_KEYS })
  clearFeatureFlag(@Param('key') key: string, @Session() session: UserSession) {
    return this.flags.clearPlatformOverride({
      key: assertKnown<FeatureFlagKey>(key, isFeatureFlagKey, 'feature-flag'),
      actorUserId: session.user.id,
    });
  }

  @Put('feature-flags/:key/organizations/:organizationId')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'setFeatureFlagOrganizationOverride',
    summary: 'Set a feature flag override for one organization',
  })
  @ApiParam({ name: 'key', enum: FEATURE_FLAG_KEYS })
  @ApiParam({ name: 'organizationId' })
  setOrganizationFeatureFlag(
    @Param('key') key: string,
    @Param('organizationId') organizationId: string,
    @Body() body: FeatureFlagOverrideDto,
    @Session() session: UserSession,
  ) {
    return this.flags.setOrganizationOverride({
      key: assertKnown<FeatureFlagKey>(key, isFeatureFlagKey, 'feature-flag'),
      organizationId,
      enabled: body.enabled,
      actorUserId: session.user.id,
    });
  }

  @Delete('feature-flags/:key/organizations/:organizationId')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'clearFeatureFlagOrganizationOverride',
    summary: 'Remove one organization override for a feature flag',
  })
  @ApiParam({ name: 'key', enum: FEATURE_FLAG_KEYS })
  @ApiParam({ name: 'organizationId' })
  clearOrganizationFeatureFlag(
    @Param('key') key: string,
    @Param('organizationId') organizationId: string,
    @Session() session: UserSession,
  ) {
    return this.flags.clearOrganizationOverride({
      key: assertKnown<FeatureFlagKey>(key, isFeatureFlagKey, 'feature-flag'),
      organizationId,
      actorUserId: session.user.id,
    });
  }

  // --- Runtime settings ----------------------------------------------------

  @Get('settings')
  @UserHasPermission({ permissions: { controlPlane: ['read'] } })
  @ApiOperation({
    operationId: 'listRuntimeSettings',
    summary: 'List every runtime setting with its resolved value',
  })
  listSettings() {
    return this.settings.listAll();
  }

  @Put('settings/:key')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'setRuntimeSetting',
    summary: 'Set a runtime setting, validated by its registered schema',
  })
  @ApiParam({ name: 'key', enum: RUNTIME_SETTING_KEYS })
  setSetting(
    @Param('key') key: string,
    @Body() body: RuntimeSettingValueDto,
    @Session() session: UserSession,
  ) {
    return this.settings.set({
      key: assertKnown<RuntimeSettingKey>(
        key,
        isRuntimeSettingKey,
        'runtime-setting',
      ),
      value: body.value,
      actorUserId: session.user.id,
    });
  }

  @Delete('settings/:key')
  @UserHasPermission({ permissions: { controlPlane: ['write'] } })
  @ApiOperation({
    operationId: 'resetRuntimeSetting',
    summary: 'Remove a stored setting and fall back to the code default',
  })
  @ApiParam({ name: 'key', enum: RUNTIME_SETTING_KEYS })
  resetSetting(@Param('key') key: string, @Session() session: UserSession) {
    return this.settings.reset({
      key: assertKnown<RuntimeSettingKey>(
        key,
        isRuntimeSettingKey,
        'runtime-setting',
      ),
      actorUserId: session.user.id,
    });
  }

  // --- Managed secrets -----------------------------------------------------

  @Get('secrets')
  @UserHasPermission({ permissions: { controlPlane: ['read'] } })
  @ApiOperation({
    operationId: 'listManagedSecrets',
    summary: 'List credential slots and whether each is configured and usable',
  })
  listSecrets() {
    return this.secrets.describeAll();
  }

  @Put('secrets/:key')
  @UserHasPermission({ permissions: { managedSecret: ['write'] } })
  @ApiOperation({
    operationId: 'setManagedSecret',
    summary: 'Store or rotate a provider credential',
  })
  @ApiParam({ name: 'key', enum: MANAGED_SECRET_KEYS })
  setSecret(
    @Param('key') key: string,
    @Body() body: ManagedSecretDto,
    @Session() session: UserSession,
  ) {
    return this.secrets.set({
      key: assertKnown<ManagedSecretKey>(key, isManagedSecretKey, 'secret'),
      value: body.value,
      label: body.label,
      actorUserId: session.user.id,
    });
  }

  @Delete('secrets/:key')
  @UserHasPermission({ permissions: { managedSecret: ['write'] } })
  @ApiOperation({
    operationId: 'removeManagedSecret',
    summary: 'Remove a stored provider credential',
  })
  @ApiParam({ name: 'key', enum: MANAGED_SECRET_KEYS })
  removeSecret(@Param('key') key: string, @Session() session: UserSession) {
    return this.secrets.remove({
      key: assertKnown<ManagedSecretKey>(key, isManagedSecretKey, 'secret'),
      actorUserId: session.user.id,
    });
  }

  // --- Audit ---------------------------------------------------------------

  @Get('audit')
  @UserHasPermission({ permissions: { controlPlane: ['read'] } })
  @ApiOperation({
    operationId: 'listControlPlaneAudit',
    summary: 'List one bounded page of control-plane change history',
  })
  listAudit(@Query() query: AuditQueryDto) {
    return this.audit.list({
      cursor: query.cursor,
      limit: query.limit,
      resource: query.resource,
      resourceKey: query.resourceKey,
      organizationId: query.organizationId,
    });
  }
}
