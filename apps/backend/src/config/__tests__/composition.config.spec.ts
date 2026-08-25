import {
  agentsConfig,
  appConfig,
  authConfig,
  cliConfigurations,
  configurations,
  databaseConfig,
  geoIpConfig,
  httpConfig,
  mailConfig,
  observabilityConfig,
  openapiConfig,
  queueConfig,
  redisConfig,
  encryptionConfig,
  workerConfigurations,
} from '..';

describe('process configuration composition', () => {
  it('loads only worker-owned namespaces in the worker process', () => {
    expect(workerConfigurations).toEqual([
      appConfig,
      databaseConfig,
      // Shared with the API, and deliberately: an agent run resolves its
      // provider credential when it executes, not when it was accepted, so the
      // worker decrypts managed secrets itself rather than receiving one in a
      // job payload that would sit in Redis going stale.
      encryptionConfig,
      observabilityConfig,
      redisConfig,
      queueConfig,
      agentsConfig,
    ]);

    /**
     * Agent reconciliation is worker-only, and this is where that stays true.
     * The API composition root must not even parse those variables: nothing in
     * a request path may sweep runs, so requiring their configuration there
     * would advertise a capability the process is meant to lack.
     */
    expect(configurations).not.toEqual(expect.arrayContaining([agentsConfig]));
    expect(workerConfigurations).not.toEqual(
      expect.arrayContaining([
        authConfig,
        geoIpConfig,
        httpConfig,
        mailConfig,
        openapiConfig,
      ]),
    );
  });

  /**
   * The bootstrap CLI must not require the control-plane master key.
   *
   * It runs before anything has been configured, on a host where the operator
   * is repairing exactly the situation where the environment may be
   * incomplete. Parsing `APP_ENCRYPTION_KEY` there would make creating the
   * first super administrator fail on the absence of a value that command has
   * no use for — and there is a second reason to keep it out: the CLI reads no
   * managed secret, so handing it the key that decrypts every provider
   * credential is scope it does not need.
   */
  it('does not require the master key in the bootstrap CLI', () => {
    expect(cliConfigurations).not.toEqual(
      expect.arrayContaining([encryptionConfig]),
    );
  });
});
