import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import geoIpConfig from '../core/geoip/geoip.config';
import httpConfig from './http.config';
import mailConfig from './mail.config';
import observabilityConfig from './observability.config';
import openapiConfig from './openapi.config';
import queueConfig from './queue.config';
import redisConfig from './redis.config';

export {
  appConfig,
  authConfig,
  databaseConfig,
  geoIpConfig,
  httpConfig,
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
  geoIpConfig,
  httpConfig,
  observabilityConfig,
  authConfig,
  mailConfig,
  openapiConfig,
  redisConfig,
  queueConfig,
];

/** Configuration namespaces used by the non-HTTP worker composition root. */
export const workerConfigurations = [
  appConfig,
  databaseConfig,
  observabilityConfig,
  redisConfig,
  queueConfig,
];
