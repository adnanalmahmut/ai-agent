import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { rotationConfigurations } from '../infrastructure/config';
import { ControlPlaneAuditService } from '../features/control-plane/audit/control-plane-audit.service';
import { ManagedSecretKeyring } from '../features/control-plane/managed-secrets/managed-secret-keyring';
import { ManagedSecretRotationService } from '../features/control-plane/managed-secrets/managed-secret-rotation.service';
import { DatabaseModule } from '../infrastructure/database';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: rotationConfigurations,
    }),
    DatabaseModule,
  ],
  providers: [
    ManagedSecretKeyring,
    ControlPlaneAuditService,
    ManagedSecretRotationService,
  ],
})
export class RotationCliModule {}
