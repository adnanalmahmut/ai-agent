import {
  agentsConfig,
  appConfig,
  authConfig,
  configurations,
  databaseConfig,
  geoIpConfig,
  httpConfig,
  mailConfig,
  observabilityConfig,
  openapiConfig,
  queueConfig,
  redisConfig,
  workerConfigurations,
} from '..';

describe('process configuration composition', () => {
  it('loads only worker-owned namespaces in the worker process', () => {
    expect(workerConfigurations).toEqual([
      appConfig,
      databaseConfig,
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
});
