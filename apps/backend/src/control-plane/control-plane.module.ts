import { Module } from '@nestjs/common';

import { DatabaseModule } from '../infrastructure/database';
import { ControlPlaneAuditService } from './audit/control-plane-audit.service';
import { ControlPlaneController } from './control-plane.controller';
import { FeatureFlagService } from './feature-flags/feature-flag.service';
import { ManagedSecretKeyring } from './managed-secrets/managed-secret-keyring';
import { ManagedSecretService } from './managed-secrets/managed-secret.service';
import { RuntimeConfigResolver } from './runtime-config.resolver';
import { RuntimeSettingService } from './runtime-settings/runtime-setting.service';

/**
 * The control plane, in both composition roots.
 *
 * The API needs it to gate acceptance and to serve the operator surface. The
 * worker needs it too, and for a reason worth stating: an agent run accepted
 * yesterday executes today, and the credential it must use is whichever one is
 * current at execution time — so the worker resolves secrets itself rather than
 * receiving one in a job payload. A credential in a queue payload would sit in
 * Redis, survive in a completed job, and be exactly as stale as the moment it
 * was enqueued.
 *
 * The controller is declared here, so importing this module into the worker
 * would ordinarily drag an HTTP surface into a process that serves none. It
 * does not, because `WorkerModule` imports `ControlPlaneCoreModule` — the same
 * providers without the controller. Both are exported from this file so the
 * split is visible in one place rather than inferred from two.
 */
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

/** The core plus the operator HTTP surface. For `AppModule` only. */
@Module({
  imports: [ControlPlaneCoreModule],
  controllers: [ControlPlaneController],
  exports: [ControlPlaneCoreModule],
})
export class ControlPlaneModule {}
