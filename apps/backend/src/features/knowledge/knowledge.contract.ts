import { z } from 'zod';

import { KNOWLEDGE_SPACE_SLUGS } from './knowledge-space.registry';

/**
 * The Knowledge API payload contract. These schemas are the single authored
 * definition of what the endpoints send: the services take their return types
 * from `z.output`, and the OpenAPI document takes its schemas from `z.input`.
 *
 * Nothing here validates a response at runtime. It defines the contract and
 * types it; the interceptor still serializes whatever a handler returns.
 */

/**
 * A timestamp at the HTTP boundary. The application side is a `Date`, which is
 * what Prisma returns and what handlers keep working with; the wire side is an
 * ISO-8601 string, which is what JSON serialization already emits. Expressing
 * both in one codec is what lets a single schema own the two representations
 * instead of a hand-maintained pair.
 */
export const isoDateTimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});

// The canonical slug list stays the registry's; this only reads it.
const knowledgeSpaceSlug = z.enum(KNOWLEDGE_SPACE_SLUGS);

export const knowledgeSpaceSummarySchema = z.object({
  slug: knowledgeSpaceSlug,
  name: z.string(),
  description: z.string(),
  configured: z.boolean(),
  documentCount: z.number().int(),
  createdAt: isoDateTimeToDate.nullable(),
  updatedAt: isoDateTimeToDate.nullable(),
});

export const documentListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceUri: z.string().nullable(),
  checksum: z.string(),
  revision: z.number().int(),
  createdAt: isoDateTimeToDate,
  updatedAt: isoDateTimeToDate,
  _count: z.object({ chunks: z.number().int() }),
});

/**
 * Cursor pagination, which is not the envelope's `page`/`perPage` metadata:
 * the interceptor only lifts pagination out of a payload that carries a
 * `pagination` key, so this whole object is the response `data`.
 */
export const documentPageSchema = z.object({
  items: z.array(documentListItemSchema),
  nextCursor: z.string().nullable(),
});

export const ingestedDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  sourceUri: z.string().nullable(),
  checksum: z.string(),
  revision: z.number().int(),
  chunkCount: z.number().int(),
  changed: z.boolean(),
  createdAt: isoDateTimeToDate,
  updatedAt: isoDateTimeToDate,
});

export const clearedKnowledgeSpaceSchema = z.object({
  slug: knowledgeSpaceSlug,
});

export const deletedKnowledgeDocumentSchema = z.object({ id: z.string() });
