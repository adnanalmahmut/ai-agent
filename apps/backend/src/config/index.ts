import agentsConfig from './agents.config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import encryptionConfig from './encryption.config';
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
 *
 * `encryptionConfig` stays out for a second reason as well: this composition
 * reads no managed secret, so the key that decrypts every provider credential
 * is scope it does not need. The one command that does need it composes
 * separately — see `rotationConfigurations`.
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

/**
 * Configuration namespaces used by the managed-secret rotation command.
 *
 * The mirror image of `cliConfigurations`, and separate from it for exactly the
 * reason that list keeps the master key out. Re-encrypting credentials needs
 * the keyring and the database and demonstrably nothing else: no authentication
 * stack, no mail, no HTTP, no OpenAPI. Composing the two commands together
 * would mean each carried the other's scope — the bootstrap command holding the
 * key to every provider credential, and the rotation command able to mint an
 * administrator account.
 */
export const rotationConfigurations = [databaseConfig, encryptionConfig];

/** Configuration namespaces used by the non-HTTP worker composition root. */
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
];
