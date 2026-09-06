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

/**
 * The caller-supplied key that makes a create request safe to retry.
 *
 * Two endpoints require it, and both validated it against their own copy of
 * these bounds. One definition is what lets the OpenAPI document describe the
 * header the handler actually enforces rather than a second opinion about it.
 */
export const idempotencyKeySchema = z.string().trim().min(8).max(200);

/** The header that carries it. Case is not significant on the wire. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
