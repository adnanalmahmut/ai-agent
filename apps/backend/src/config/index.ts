import agentsConfig from './agents.config';
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
  agentsConfig,
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

/**
 * Configuration namespaces used by the operator CLI composition root.
 *
 * The CLI needs the authentication stack — it creates a credential account
 * through the same Better Auth instance the API serves — so it parses the
 * config that stack is built from. What it deliberately omits is the transport
 * layer: no Redis and no queue, because an operator command neither accepts a
 * request nor produces background work, and requiring those variables would
 * make the one command that repairs a broken deployment depend on more of it.
 *
 * Observability is omitted for the same reason and one more: the CLI's logger
 * is static and silent, so nothing reads those values, and parsing a variable
 * nothing consumes is one more way for the command to fail on a host where the
 * thing it is meant to repair is what is broken.
 */
export const cliConfigurations = [
  appConfig,
  databaseConfig,
  geoIpConfig,
  httpConfig,
  authConfig,
  mailConfig,
  openapiConfig,
];

/** Configuration namespaces used by the non-HTTP worker composition root. */
export const workerConfigurations = [
  appConfig,
  databaseConfig,
  observabilityConfig,
  redisConfig,
  queueConfig,
  // Worker-only: the reconciler runs nowhere else, so the API process never
  // parses or requires these variables.
  agentsConfig,
];
