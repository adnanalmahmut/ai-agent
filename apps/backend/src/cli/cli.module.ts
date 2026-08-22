import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { LoggerModule } from 'nestjs-pino';

import { cliConfigurations } from '../config';
import { AppAuthModule, type AppAuth } from '../core/auth';
import { AppI18nModule } from '../core/i18n';
import { DatabaseModule } from '../database';
import {
  ADMIN_USER_API,
  PASSWORD_POLICY,
  resolveAdminUserApi,
  resolvePasswordPolicy,
} from './admin-user-api';
import { SuperAdminBootstrap } from './super-admin.bootstrap';

/**
 * The operator CLI's composition root.
 *
 * A third root beside `AppModule` and `WorkerModule`, for the same reason the
 * worker has its own: what a process must be *unable* to do is part of the
 * design. This one can create a credential account, so it must be the process
 * that serves no traffic and consumes no queue.
 *
 * It imports `AppAuthModule` rather than rebuilding Better Auth, because the
 * whole point of the command is that the account it writes is indistinguishable
 * from one the API would have written — same password hashing configuration,
 * same role catalogue, same additional fields. A second construction path would
 * be a second set of rules to keep in step, and the failure would be silent
 * until someone could not sign in.
 *
 * `AppAuthModule` also declares HTTP controllers. In an application context
 * those are instantiated and never routed, which is harmless and is the price
 * of not forking the module.
 *
 * No logger module: an operator command writes for a person reading a terminal,
 * not for a log aggregator, so it prints plain lines and Nest's own bootstrap
 * logging stays buffered and discarded.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: cliConfigurations,
    }),
    /**
     * Present only to satisfy the auth stack's transitive need for `PinoLogger`,
     * and silenced. The command's audience is a terminal, so structured JSON
     * interleaved with a password prompt would be actively harmful; `silent` is
     * a real pino level, so nothing is emitted rather than merely redirected.
     */
    LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
    DatabaseModule,
    // Mail renders localized templates, and Better Auth is constructed with the
    // mail capability, so the auth stack transitively needs the i18n provider
    // even though this command sends nothing. Discovered by running the
    // command, not by reading the graph.
    AppI18nModule,
    AppAuthModule,
  ],
  providers: [
    SuperAdminBootstrap,
    {
      provide: ADMIN_USER_API,
      inject: [AuthService],
      useFactory: (auth: AuthService<AppAuth>) => resolveAdminUserApi(auth),
    },
    {
      provide: PASSWORD_POLICY,
      inject: [AuthService],
      useFactory: (auth: AuthService<AppAuth>) => resolvePasswordPolicy(auth),
    },
  ],
})
export class CliModule {}
