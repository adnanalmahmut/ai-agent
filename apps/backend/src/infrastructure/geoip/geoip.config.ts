import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  GEOIP_DATABASE_PATH: z
    .string()
    .min(1)
    .default('/usr/share/GeoIP/GeoLite2-City.mmdb'),
  GEOIP_READER_RETRY_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),
});

export default registerAs('geoip', () => {
  const env = schema.parse(process.env);

  return {
    databasePath: env.GEOIP_DATABASE_PATH,
    readerRetryMs: env.GEOIP_READER_RETRY_MS,
  };
});
