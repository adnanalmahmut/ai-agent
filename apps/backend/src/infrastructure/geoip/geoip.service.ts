import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { isIP } from 'node:net';
import { PinoLogger } from 'nestjs-pino';

import geoIpConfig from './geoip.config';
import {
  GEOIP_READER_OPEN,
  type GeoIpReader,
  type GeoIpReaderOpen,
} from './geoip.reader';

export type GeoIpLocation = {
  country: string | null;
  city: string | null;
};

const UNKNOWN_LOCATION: GeoIpLocation = { country: null, city: null };

@Injectable()
export class GeoIpService {
  private reader: GeoIpReader | null = null;
  private opening: Promise<GeoIpReader | null> | null = null;
  private lastOpenFailureAt = 0;

  constructor(
    @Inject(geoIpConfig.KEY)
    private readonly config: ConfigType<typeof geoIpConfig>,
    @Inject(GEOIP_READER_OPEN)
    private readonly openReader: GeoIpReaderOpen,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GeoIpService.name);
  }

  async lookup(ipAddress: string | null | undefined): Promise<GeoIpLocation> {
    const publicIp = normalizePublicIp(ipAddress);
    if (!publicIp) return UNKNOWN_LOCATION;

    const reader = await this.getReader();
    if (!reader) return UNKNOWN_LOCATION;

    try {
      const record = reader.city(publicIp);
      const country = normalizeCountry(record.country?.isoCode);
      const city = normalizeCity(record.city?.names.en);

      return { country, city };
    } catch (error) {
      this.logger.warn(
        { errorType: errorName(error) },
        'GeoIP lookup failed open; session location is unavailable',
      );
      return UNKNOWN_LOCATION;
    }
  }

  private async getReader(): Promise<GeoIpReader | null> {
    if (this.reader) return this.reader;
    if (this.opening) return this.opening;

    const now = Date.now();
    if (now - this.lastOpenFailureAt < this.config.readerRetryMs) return null;

    const opening = this.openReader(this.config.databasePath)
      .then((reader) => {
        this.reader = reader;
        this.lastOpenFailureAt = 0;
        this.logger.info('GeoIP database reader is ready');
        return reader;
      })
      .catch((error: unknown) => {
        this.lastOpenFailureAt = Date.now();
        this.logger.warn(
          { errorType: errorName(error) },
          'GeoIP database is unavailable; session location will remain empty',
        );
        return null;
      });

    this.opening = opening;
    try {
      return await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function normalizeCountry(value: string | undefined): string | null {
  const country = value?.toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}

function normalizeCity(value: string | undefined): string | null {
  const city = value?.trim();
  return city ? city.slice(0, 255) : null;
}

export function normalizePublicIp(
  ipAddress: string | null | undefined,
): string | null {
  if (!ipAddress) return null;

  const value = ipAddress.trim().toLowerCase();
  const mappedV4 = value.startsWith('::ffff:') ? value.slice(7) : value;
  const version = isIP(mappedV4);
  if (version === 0) return null;

  if (version === 4) {
    const octets = mappedV4.split('.').map(Number);
    const [a = 0, b = 0] = octets;

    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return null;
    }

    return mappedV4;
  }

  if (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('ff')
  ) {
    return null;
  }

  return value;
}
