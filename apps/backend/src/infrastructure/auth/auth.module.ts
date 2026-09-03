import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { AuthModule } from '@thallesp/nestjs-better-auth';

import { appConfig, authConfig, httpConfig, openapiConfig } from '../config';
import { DatabaseModule, PrismaService } from '../database';
import { GeoIpModule, GeoIpService } from '../geoip';
import { overwriteDirectClientIpHeaders } from '../http';
import { MailModule, MailService } from '../mail';
import { assignRequestId } from '../providers/request-id';
import { AccountLifecycleService } from './account-lifecycle.service';
import { createAuth } from './auth.factory';
import {
  AccountLifecycleController,
  OrganizationLifecycleController,
  SelfAccountLifecycleController,
} from './lifecycle.controller';
import { OrganizationLifecycleService } from './organization-lifecycle.service';

@Module({
  imports: [
    DatabaseModule,
    AuthModule.forRootAsync({
      imports: [DatabaseModule, MailModule, GeoIpModule],
      inject: [
        PrismaService,
        MailService,
        GeoIpService,
        authConfig.KEY,
        appConfig.KEY,
        httpConfig.KEY,
        openapiConfig.KEY,
      ],
      useFactory: (
        prisma: PrismaService,
        mail: MailService,
        geoIp: GeoIpService,
        config: ConfigType<typeof authConfig>,
        app: ConfigType<typeof appConfig>,
        http: ConfigType<typeof httpConfig>,
        openapi: ConfigType<typeof openapiConfig>,
      ) => ({
        auth: createAuth({
          prisma,
          mail,
          geoIp,
          config,
          app,
          openApiEnabled: openapi.enabled,
        }),
        bodyParser: {
          json: { limit: '1mb' },
          urlencoded: { extended: true, limit: '1mb' },
        },
        // Better Auth routes bypass the NestJS middleware chain (where Pino
        // genReqId lives). This hook runs the same shared assignRequestId
        // function so every auth response carries X-Request-ID from the
        // single source of truth.
        middleware: (
          req: IncomingMessage,
          res: ServerResponse,
          next: () => void,
        ) => {
          overwriteDirectClientIpHeaders(req, http.overwriteDirectIpHeaders);
          assignRequestId(req, res);
          next();
        },
      }),
    }),
  ],
  controllers: [
    AccountLifecycleController,
    SelfAccountLifecycleController,
    OrganizationLifecycleController,
  ],
  providers: [AccountLifecycleService, OrganizationLifecycleService],
  exports: [AuthModule, AccountLifecycleService, OrganizationLifecycleService],
})
export class AppAuthModule {}
