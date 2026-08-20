import type { ReaderModel } from '@maxmind/geoip2-node';

export const GEOIP_READER_OPEN = Symbol('GEOIP_READER_OPEN');

export type GeoIpReader = Pick<ReaderModel, 'city'>;
export type GeoIpReaderOpen = (databasePath: string) => Promise<GeoIpReader>;
