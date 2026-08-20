import {
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
    ]);
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
