import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  Session,
  UserHasPermission,
  type UserSession,
} from '@thallesp/nestjs-better-auth';
import { z } from 'zod';

import { AppException } from '../../core/errors';
import {
  apiSuccessSchema,
  createZodDto,
  wireSchemaOf,
} from '../../infrastructure/http';
import { ControlPlaneAuditService } from './audit/control-plane-audit.service';
import {
  controlPlaneAuditPageSchema,
  controlPlaneAuditQuerySchema,
  featureFlagOverrideSchema,
  featureFlagStateSchema,
  managedSecretDescriptionSchema,
  managedSecretInputSchema,
  runtimeSettingStateSchema,
  runtimeSettingValueSchema,
} from './control-plane.contract';
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

const enabledSchema = featureFlagOverrideSchema;
class FeatureFlagOverrideDto extends createZodDto(enabledSchema) {}

const settingValueSchema = runtimeSettingValueSchema;
class RuntimeSettingValueDto extends createZodDto(settingValueSchema) {}

const secretSchema = managedSecretInputSchema;
class ManagedSecretDto extends createZodDto(secretSchema) {}

const auditQuerySchema = controlPlaneAuditQuerySchema;
class AuditQueryDto extends createZodDto(auditQuerySchema) {}

const flagResponse = { schema: apiSuccessSchema(featureFlagStateSchema) };
const settingResponse = { schema: apiSuccessSchema(runtimeSettingStateSchema) };
const secretResponse = {
  schema: apiSuccessSchema(managedSecretDescriptionSchema),
};

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
  @ApiOkResponse({
    schema: apiSuccessSchema(z.array(featureFlagStateSchema)),
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
  @ApiOkResponse({
    schema: apiSuccessSchema(z.array(featureFlagStateSchema)),
  })
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
  @ApiBody({ schema: wireSchemaOf(enabledSchema) })
  @ApiOkResponse(flagResponse)
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
  @ApiOkResponse(flagResponse)
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
  @ApiBody({ schema: wireSchemaOf(enabledSchema) })
  @ApiOkResponse(flagResponse)
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
  @ApiOkResponse(flagResponse)
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
  @ApiOkResponse({
    schema: apiSuccessSchema(z.array(runtimeSettingStateSchema)),
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
  @ApiBody({ schema: wireSchemaOf(settingValueSchema) })
  @ApiOkResponse(settingResponse)
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
  @ApiOkResponse(settingResponse)
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
  @ApiOkResponse({
    schema: apiSuccessSchema(z.array(managedSecretDescriptionSchema)),
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
  // The credential crosses only in this direction: the response schema
  // carries no value, so returning one would not typecheck.
  @ApiBody({ schema: wireSchemaOf(secretSchema) })
  @ApiOkResponse(secretResponse)
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
  @ApiOkResponse(secretResponse)
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
  // Names, optionality and value semantics come from the same Zod schema
  // that validates the query, so the two cannot describe different things.
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: wireSchemaOf(auditQuerySchema.shape.cursor),
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: wireSchemaOf(auditQuerySchema.shape.limit),
  })
  @ApiQuery({
    name: 'resource',
    required: false,
    schema: wireSchemaOf(auditQuerySchema.shape.resource),
  })
  @ApiQuery({
    name: 'resourceKey',
    required: false,
    schema: wireSchemaOf(auditQuerySchema.shape.resourceKey),
  })
  @ApiQuery({
    name: 'organizationId',
    required: false,
    schema: wireSchemaOf(auditQuerySchema.shape.organizationId),
  })
  @ApiOkResponse({ schema: apiSuccessSchema(controlPlaneAuditPageSchema) })
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
