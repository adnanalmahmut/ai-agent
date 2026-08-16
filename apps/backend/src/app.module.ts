import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { appConfig, configurations, observabilityConfig } from './config';
import { AppAuthModule } from './core/auth';
import { HttpInfrastructureModule } from './core/http';
import { AppI18nModule } from './core/i18n';
import { MailModule } from './core/mail';
import { createLoggerOptions } from './core/providers/logger.options';
import { DatabaseModule } from './database';

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
    AppI18nModule,
    HttpInfrastructureModule,
    DatabaseModule,
    MailModule,
    AppAuthModule,
  ],
})
export class AppModule {}
