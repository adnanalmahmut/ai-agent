import { z } from 'zod';

import { AGENT_RUN_STATUSES } from '../../../ai/agents/agent.types';
import { isoDateTimeToDate } from '../../../infrastructure/http';
import { contentIdeaInput, contentIdeaOutput } from './agent-definitions';

/**
 * The Content Ideas API payload contract. These schemas are the single
 * authored definition of what the endpoints send and accept: the service takes
 * its return types from `z.output`, and the OpenAPI document takes its schemas
 * from `z.input`, so Platform reads the generated form of the same definition
 * rather than a second description of it.
 *
 * Nothing here validates a response at runtime. It defines the contract and
 * types it; the interceptor still serializes whatever a handler returns.
 */

/**
 * Why this organization may not generate ideas right now. `null` where it may.
 */
export const CONTENT_IDEA_UNAVAILABLE_REASONS = [
  'agents_disabled',
  'content_ideas_disabled',
  'agent_not_installed',
  'agent_disabled',
] as const;

export type ContentIdeaUnavailableReason =
  (typeof CONTENT_IDEA_UNAVAILABLE_REASONS)[number];

export const contentIdeaAvailabilitySchema = z.object({
  available: z.boolean(),
  reason: z.enum(CONTENT_IDEA_UNAVAILABLE_REASONS).nullable(),
});

/**
 * The result a succeeded request carries.
 *
 * The agent's own output schema is the definition; the runner stores what that
 * schema parsed, so `sources` has already had its default applied by the time
 * a client can read it. Unwrapping the default is what keeps the documented
 * response saying `sources` is always present, which is true of the stored
 * value, rather than saying it is optional, which is only true of what the
 * agent may return.
 */
export const contentIdeaResultSchema = contentIdeaOutput.extend({
  sources: contentIdeaOutput.shape.sources.unwrap(),
});

/**
 * A content-idea request as an operation the caller follows: the accepted
 * response and the status read answer with the same shape, which is what lets
 * the screen hold one value from acceptance through to a terminal state.
 *
 * `output` is populated only once the run has succeeded.
 */
export const contentIdeaOperationSchema = z.object({
  id: z.string(),
  status: z.enum(AGENT_RUN_STATUSES),
  output: contentIdeaResultSchema.nullable(),
  createdAt: isoDateTimeToDate,
  completedAt: isoDateTimeToDate.nullable(),
});

/** The request body, which is the agent's own declared input. */
export const requestContentIdeasSchema = contentIdeaInput;
