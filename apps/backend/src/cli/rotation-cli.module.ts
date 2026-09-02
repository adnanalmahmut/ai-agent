import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { rotationConfigurations } from '../infrastructure/config';
import { ControlPlaneAuditService } from '../control-plane/audit/control-plane-audit.service';
import { ManagedSecretKeyring } from '../control-plane/managed-secrets/managed-secret-keyring';
import { ManagedSecretRotationService } from '../control-plane/managed-secrets/managed-secret-rotation.service';
import { DatabaseModule } from '../infrastructure/database';

/**
 * The key-rotation command's composition root.
 *
 * A fourth root, and separate from `CliModule` for the reason that module keeps
 * the master key out of itself: what a process is *unable* to do is part of the
 * design. These two operator commands need disjoint authority — rotation reads
 * and rewrites every stored credential, bootstrap mints an administrator
 * account — and composing them together would hand each one the other's reach.
 * Only the command that was actually invoked is ever constructed.
 *
 * What is absent is the point. No authentication stack, so this process cannot
 * create or elevate an account. No mail, no HTTP, no OpenAPI, no i18n: it
 * answers to nobody and renders nothing. What remains is a database connection
 * and a keyring, which is the whole of what re-encrypting a column requires.
 *
 * This is an injection boundary, not a process one. The command runs inside the
 * `backend` service, whose `process.env` still carries every credential that
 * service is given. Narrowing the graph does not remove them from the
 * environment; what it buys is that no auth stack, mail transport, HTTP server,
 * or queue producer is ever constructed, so nothing in this process is in a
 * position to read, log, or transmit them.
 *
 * `ControlPlaneAuditService` is provided directly rather than by importing
 * `ControlPlaneCoreModule`, which would also bring feature flags, runtime
 * settings, the resolver, and HTTP controllers — none of which an operator
 * command should be able to reach.
 */
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
