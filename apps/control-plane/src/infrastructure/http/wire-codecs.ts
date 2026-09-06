import { z } from 'zod';

/**
 * Codecs shared by the payload contracts, which own the two representations
 * of one value in a single schema rather than a hand-maintained pair.
 */

/**
 * A timestamp at the HTTP boundary. The application side is a `Date`, which is
 * what Prisma returns and what handlers keep working with; the wire side is an
 * ISO-8601 string, which is what JSON serialization already emits.
 *
 * `wireSchemaOf` reads the input side, so a contract built on this codec
 * documents the string a client receives while the handler still returns a
 * `Date`.
 */
export const isoDateTimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});
