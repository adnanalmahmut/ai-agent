import { describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';

import geoIpConfig from '../../../../src/infrastructure/geoip/geoip.config';
import {
  GEOIP_READER_OPEN,
  type GeoIpReader,
  type GeoIpReaderOpen,
} from '../../../../src/infrastructure/geoip/geoip.reader';
import {
  GeoIpService,
  normalizePublicIp,
} from '../../../../src/infrastructure/geoip/geoip.service';

const config = {
  databasePath: '/test/GeoLite2-City.mmdb',
  readerRetryMs: 60_000,
};

const logger = () => ({
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
});

async function createService(openReader: GeoIpReaderOpen) {
  const log = logger();
  const module = await Test.createTestingModule({
    providers: [
      GeoIpService,
      { provide: geoIpConfig.KEY, useValue: config },
      { provide: GEOIP_READER_OPEN, useValue: openReader },
      { provide: PinoLogger, useValue: log },
    ],
  }).compile();

  return { service: module.get(GeoIpService), logger: log };
}

describe('GeoIpService', () => {
  it('reads a country code and city from the local database', async () => {
    const city = jest.fn((ipAddress: string) => {
      void ipAddress;
      return {
        country: { isoCode: 'tr' },
        city: { names: { en: 'Istanbul' } },
      };
    });
    const openReader = jest.fn((databasePath: string) => {
      void databasePath;
      return Promise.resolve({ city } as unknown as GeoIpReader);
    });
    const { service } = await createService(openReader);

    await expect(service.lookup('8.8.8.8')).resolves.toEqual({
      country: 'TR',
      city: 'Istanbul',
    });
    expect(openReader).toHaveBeenCalledWith(config.databasePath);
    expect(city).toHaveBeenCalledWith('8.8.8.8');
  });

  it.each([
    null,
    '',
    'not-an-ip',
    '127.0.0.1',
    '::ffff:127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
  ])('fails open without reading MMDB for %s', async (ipAddress) => {
    const openReader = jest.fn<GeoIpReaderOpen>();
    const { service } = await createService(openReader);

    await expect(service.lookup(ipAddress)).resolves.toEqual({
      country: null,
      city: null,
    });
    expect(openReader).not.toHaveBeenCalled();
  });

  it('fails open and bounds retries when the database is missing', async () => {
    const openReader = jest
      .fn<GeoIpReaderOpen>()
      .mockRejectedValue(new Error('ENOENT'));
    const { service, logger: log } = await createService(openReader);

    await expect(service.lookup('8.8.8.8')).resolves.toEqual({
      country: null,
      city: null,
    });
    await expect(service.lookup('1.1.1.1')).resolves.toEqual({
      country: null,
      city: null,
    });
    expect(openReader).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open when the reader throws or has no matching record', async () => {
    const reader = {
      city: jest.fn((ipAddress: string) => {
        void ipAddress;
        throw new Error('AddressNotFoundError');
      }),
    } as unknown as GeoIpReader;
    const { service, logger: log } = await createService((databasePath) => {
      void databasePath;
      return Promise.resolve(reader);
    });

    await expect(service.lookup('8.8.8.8')).resolves.toEqual({
      country: null,
      city: null,
    });
    expect(log.warn).toHaveBeenCalledWith(
      { errorType: 'Error' },
      expect.stringContaining('failed open'),
    );
  });
});

describe('normalizePublicIp', () => {
  it('normalizes a public IPv4-mapped address', () => {
    expect(normalizePublicIp('::ffff:8.8.8.8')).toBe('8.8.8.8');
  });

  it('keeps a public IPv6 address', () => {
    expect(normalizePublicIp('2001:4860:4860::8888')).toBe(
      '2001:4860:4860::8888',
    );
  });
});
