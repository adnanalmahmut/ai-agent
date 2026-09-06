import { z } from 'zod';

import { isoDateTimeToDate } from '../http';

/**
 * The account administration payload contract. The service takes its return
 * type from `z.output` and the OpenAPI document takes its schema from
 * `z.input`, so Platform reads the generated form of the same definition
 * rather than a second description of it.
 */

export const accountLifecycleResultSchema = z.object({
  userId: z.string(),
  // Null once an account is active again.
  deletedAt: isoDateTimeToDate.nullable(),
  // How many sessions the deactivation ended, so an operator can see that the
  // account was actually shut out rather than only marked.
  revokedSessions: z.number().int(),
});

export const accountLifecycleReasonSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();
