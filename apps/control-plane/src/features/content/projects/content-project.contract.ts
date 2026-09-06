import { z } from 'zod';

import { isoDateTimeToDate } from '../../../infrastructure/http';
import {
  CONTENT_IDEA_FORMATS,
  CONTENT_IDEA_LANGUAGES,
} from '../ideas/agent-definitions';

/**
 * The Content Projects API payload contract. These schemas are the single
 * authored definition of what the endpoints send and accept: the service takes
 * its return types from `z.output`, and the OpenAPI document takes its schemas
 * from `z.input`, so Platform reads the generated form of the same definition
 * rather than a second description of it.
 *
 * Nothing here validates a response at runtime. It defines the contract and
 * types it; the interceptor still serializes whatever a handler returns.
 */

// A project keeps the closed vocabularies of the idea it was promoted from.
const contentFormat = z.enum(CONTENT_IDEA_FORMATS);
const contentLanguage = z.enum(CONTENT_IDEA_LANGUAGES);

export const contentDraftSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  title: z.string(),
  format: contentFormat,
  language: contentLanguage,
  // Null distinguishes a draft target from authored content.
  body: z.string().nullable(),
  createdAt: isoDateTimeToDate,
});

/** What the request the project came from was asking for. */
export const contentProjectBriefSchema = z.object({
  topic: z.string(),
  goal: z.string(),
  audience: z.string().nullable(),
  guidance: z.string().nullable(),
});

/** A project as a list entry: the promoted idea, without its brief or drafts. */
export const contentProjectSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  sourceRunId: z.string(),
  sourceIdeaIndex: z.number().int(),
  title: z.string(),
  hook: z.string(),
  angle: z.string(),
  summary: z.string(),
  suggestedFormat: contentFormat,
  language: contentLanguage,
  createdByUserId: z.string().nullable(),
  createdAt: isoDateTimeToDate,
  updatedAt: isoDateTimeToDate,
});

export const contentProjectDetailSchema = contentProjectSchema.extend({
  brief: contentProjectBriefSchema,
  drafts: z.array(contentDraftSchema),
});

/**
 * Cursor pagination, which is not the envelope's `page`/`perPage` metadata:
 * the interceptor only lifts pagination out of a payload that carries a
 * `pagination` key, so this whole object is the response `data`.
 */
export const contentProjectPageSchema = z.object({
  items: z.array(contentProjectSchema),
  nextCursor: z.string().nullable(),
});

export const listContentProjectsQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();
