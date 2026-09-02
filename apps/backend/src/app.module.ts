import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import {
  appConfig,
  configurations,
  observabilityConfig,
} from './infrastructure/config';
import {
  AgentActionApprovalModule,
  AgentsModule,
  McpModule,
  OrganizationAgentInstallationsModule,
} from './agents';
import { AppAuthModule } from './infrastructure/auth';
import { HealthModule } from './infrastructure/health';
import { HttpInfrastructureModule } from './infrastructure/http';
import { AppI18nModule } from './infrastructure/i18n';
import { LifecycleModule } from './infrastructure/lifecycle';
import { MailModule } from './infrastructure/mail';
import { createLoggerOptions } from './infrastructure/providers/logger.options';
import { RateLimitModule } from './infrastructure/rate-limit';
import { ControlPlaneModule } from './control-plane';
import { ContentIdeaModule } from './content-ideas';
import { ContentProjectModule } from './content-projects';
import { KnowledgeModule } from './knowledge';
import { OrganizationBusinessProfileModule } from './organization-settings';
import { OrganizationAuditModule } from './organization-audit';
import { DatabaseModule } from './infrastructure/database';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: configurations,
    }),
    LoggerModule.forRootAsync({
      inject: [appConfig.KEY, observabilityConfig.KEY],
      useFactory: createLoggerOptions,
    }),
    LifecycleModule,
    AgentsModule,
    OrganizationAgentInstallationsModule,
    AgentActionApprovalModule,
    McpModule,
    ControlPlaneModule,
    KnowledgeModule,
    ContentIdeaModule,
    ContentProjectModule,
    OrganizationAuditModule,
    OrganizationBusinessProfileModule,
    AppI18nModule,
    HttpInfrastructureModule,
    RateLimitModule,
    DatabaseModule,
    MailModule,
    AppAuthModule,
    HealthModule,
  ],
})
export class AppModule {}
