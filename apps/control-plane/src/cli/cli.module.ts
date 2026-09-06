import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { LoggerModule } from 'nestjs-pino';

import { cliConfigurations } from '../infrastructure/config';
import { AppAuthModule, type AppAuth } from '../infrastructure/auth';
import { AppI18nModule } from '../infrastructure/i18n';
import { DatabaseModule } from '../infrastructure/database';
import {
  ADMIN_USER_API,
  PASSWORD_POLICY,
  resolveAdminUserApi,
  resolvePasswordPolicy,
} from './admin-user-api';
import { SuperAdminBootstrap } from './super-admin.bootstrap';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: cliConfigurations,
    }),
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
