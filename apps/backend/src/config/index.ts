import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import mailConfig from './mail.config';
import observabilityConfig from './observability.config';
import openapiConfig from './openapi.config';
import queueConfig from './queue.config';
import redisConfig from './redis.config';

export {
  appConfig,
  authConfig,
  databaseConfig,
  mailConfig,
  observabilityConfig,
  openapiConfig,
  queueConfig,
  redisConfig,
};
export type { LogMailConfig, MailConfig } from './mail.config';
export type { GoogleAuthConfig } from './auth.config';

export const configurations = [
  appConfig,
  databaseConfig,
  observabilityConfig,
  authConfig,
  mailConfig,
  openapiConfig,
  redisConfig,
  queueConfig,
];
