import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { AuthModule } from '@thallesp/nestjs-better-auth';

import { appConfig, authConfig, openapiConfig } from '../../config';
import { DatabaseModule, PrismaService } from '../../database';
import { MailModule, MailService } from '../mail';
import { AccountLifecycleService } from './account-lifecycle.service';
import { createAuth } from './auth.factory';
import {
  AccountLifecycleController,
  OrganizationLifecycleController,
} from './lifecycle.controller';
import { OrganizationLifecycleService } from './organization-lifecycle.service';

/**
 * Better Auth, wired to this application's Prisma client and mail capability,
 * plus the application-owned lifecycle endpoints that sit beside it.
 *
 * The Better Auth dependencies come from `imports`, not from this module's own
 * providers: `forRootAsync` resolves its factory arguments inside the dynamic
 * module it builds, so a provider declared out here would not be visible to
 * it. Both `PrismaService` and `MailService` are exported by modules that
 * already own them.
 *
 * The lifecycle services and controllers *are* declared here, because they are
 * ordinary Nest components — they use `PrismaService` directly and are reached
 * through the normal request pipeline, which is what gives them Zod validation
 * and localized errors.
 *
 * The global `AuthGuard` registered by the library is deliberately left on:
 * routes are protected unless they opt out with `@AllowAnonymous()` or
 * `@OptionalAuth()`. Forgetting the decorator produces a loud 401 in
 * development; the opposite default fails silently in production.
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule.forRootAsync({
      imports: [DatabaseModule, MailModule],
      inject: [
        PrismaService,
        MailService,
        authConfig.KEY,
        appConfig.KEY,
        openapiConfig.KEY,
      ],
      useFactory: (
        prisma: PrismaService,
        mail: MailService,
        config: ConfigType<typeof authConfig>,
        app: ConfigType<typeof appConfig>,
        openapi: ConfigType<typeof openapiConfig>,
      ) => ({
        auth: createAuth({
          prisma,
          mail,
          config,
          app,
          openApiEnabled: openapi.enabled,
        }),
      }),
    }),
  ],
  controllers: [AccountLifecycleController, OrganizationLifecycleController],
  providers: [AccountLifecycleService, OrganizationLifecycleService],
  exports: [AuthModule, AccountLifecycleService, OrganizationLifecycleService],
})
export class AppAuthModule {}
