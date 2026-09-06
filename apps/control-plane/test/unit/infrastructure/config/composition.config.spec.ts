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
  rotationConfigurations,
  workerConfigurations,
} from '../../../../src/infrastructure/config';

describe('process configuration composition', () => {
  it('loads only worker-owned namespaces in the worker process', () => {
    expect(workerConfigurations).toEqual([
      appConfig,
      databaseConfig,
      encryptionConfig,
      observabilityConfig,
      redisConfig,
      queueConfig,
      agentsConfig,
      mailConfig,
    ]);

    expect(configurations).not.toEqual(expect.arrayContaining([agentsConfig]));
    expect(workerConfigurations).not.toEqual(
      expect.arrayContaining([
        authConfig,
        geoIpConfig,
        httpConfig,
        openapiConfig,
      ]),
    );
  });

  it('does not require the master key in the bootstrap CLI', () => {
    expect(cliConfigurations).not.toEqual(
      expect.arrayContaining([encryptionConfig]),
    );
  });

  it('gives the rotation command the master key and nothing that can mint an account', () => {
    expect(rotationConfigurations).toEqual(
      expect.arrayContaining([encryptionConfig, databaseConfig]),
    );

    for (const excluded of [
      authConfig,
      mailConfig,
      httpConfig,
      openapiConfig,
      geoIpConfig,
    ]) {
      expect(rotationConfigurations).not.toContain(excluded);
    }
  });
});
