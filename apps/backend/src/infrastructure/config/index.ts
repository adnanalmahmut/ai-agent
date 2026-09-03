import agentsConfig from './agents.config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import encryptionConfig from './encryption.config';
import geoIpConfig from '../geoip/geoip.config';
import httpConfig from './http.config';
import mailConfig from './mail.config';
import observabilityConfig from './observability.config';
import openapiConfig from './openapi.config';
import queueConfig from './queue.config';
import redisConfig from './redis.config';

export {
  agentsConfig,
  appConfig,
  authConfig,
  databaseConfig,
  encryptionConfig,
  geoIpConfig,
  httpConfig,
  mailConfig,
  observabilityConfig,
  openapiConfig,
  queueConfig,
  redisConfig,
};
export type { LogMailConfig, MailConfig } from './mail.config';
export type { EncryptionConfig } from './encryption.config';
export type { GoogleAuthConfig } from './auth.config';

export const configurations = [
  appConfig,
  databaseConfig,
  encryptionConfig,
  geoIpConfig,
  httpConfig,
  observabilityConfig,
  authConfig,
  mailConfig,
  openapiConfig,
  redisConfig,
  queueConfig,
];

export const cliConfigurations = [
  appConfig,
  databaseConfig,
  geoIpConfig,
  httpConfig,
  authConfig,
  mailConfig,
  openapiConfig,
];

export const rotationConfigurations = [databaseConfig, encryptionConfig];

export const workerConfigurations = [
  appConfig,
  databaseConfig,
  // The worker resolves provider credentials when it executes an agent, so it
  // needs the master key the API needs for the same reason.
  encryptionConfig,
  observabilityConfig,
  redisConfig,
  queueConfig,
  // Worker-only: the reconciler runs nowhere else, so the API process never
  // parses or requires these variables.
  agentsConfig,
  // The worker performs the approved notification effect, so it composes the
  // same delivery driver the API's auth mail uses — and parses the same
  // variables, so a driver misconfiguration fails at boot rather than at the
  // first approved action.
  mailConfig,
];
