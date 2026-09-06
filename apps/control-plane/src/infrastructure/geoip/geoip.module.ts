import { Module } from '@nestjs/common';
import { Reader } from '@maxmind/geoip2-node';

import { GeoIpService } from './geoip.service';
import { GEOIP_READER_OPEN, type GeoIpReaderOpen } from './geoip.reader';

const openReader: GeoIpReaderOpen = (databasePath) =>
  Reader.open(databasePath, {
    watchForUpdates: true,
    watchForUpdatesNonPersistent: true,
  });

@Module({
  providers: [
    GeoIpService,
    {
      provide: GEOIP_READER_OPEN,
      useValue: openReader,
    },
  ],
  exports: [GeoIpService],
})
export class GeoIpModule {}
