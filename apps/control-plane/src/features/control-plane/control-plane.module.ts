import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infrastructure/database';
import { ControlPlaneAuditService } from './audit/control-plane-audit.service';
import { ControlPlaneController } from './control-plane.controller';
import { FeatureFlagService } from './feature-flags/feature-flag.service';
import { ManagedSecretKeyring } from './managed-secrets/managed-secret-keyring';
import { ManagedSecretService } from './managed-secrets/managed-secret.service';
import { RuntimeConfigResolver } from './runtime-config.resolver';
import { RuntimeSettingService } from './runtime-settings/runtime-setting.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    ControlPlaneAuditService,
    FeatureFlagService,
    RuntimeSettingService,
    ManagedSecretKeyring,
    ManagedSecretService,
    RuntimeConfigResolver,
  ],
  exports: [
    ControlPlaneAuditService,
    FeatureFlagService,
    RuntimeSettingService,
    ManagedSecretService,
    RuntimeConfigResolver,
  ],
})
export class ControlPlaneCoreModule {}

@Module({
  imports: [ControlPlaneCoreModule],
  controllers: [ControlPlaneController],
  exports: [ControlPlaneCoreModule],
})
export class ControlPlaneModule {}
