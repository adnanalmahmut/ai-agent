import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const REQUEST_ID_MAX_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type CorrelatedRequest = IncomingMessage & { id?: string };

/**
 * Validates and sanitizes a client-provided Request ID.
 * Returns the sanitized ID if valid; undefined otherwise.
 */
export function sanitizeIncomingRequestId(
  incoming: unknown,
): string | undefined {
  if (typeof incoming !== 'string') return undefined;

  const trimmed = incoming.trim();
  if (trimmed.length === 0 || trimmed.length > REQUEST_ID_MAX_LENGTH) {
    return undefined;
  }

  if (!REQUEST_ID_PATTERN.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

/**
 * Assigns the application's request correlation ID.
 *
 * Reuses an already assigned ID or a validated client-provided ID;
 * otherwise generates a new server-side ID (`req_<uuid>`).
 * Shared across the standard HTTP pipeline and authentication requests.
 */
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const correlatedReq = req as CorrelatedRequest;
  if (typeof correlatedReq.id === 'string' && correlatedReq.id.length > 0) {
    return correlatedReq.id;
  }

  const validClientRequestId = sanitizeIncomingRequestId(
    req.headers['x-request-id'],
  );

  const requestId = validClientRequestId ?? `req_${randomUUID()}`;

  correlatedReq.id = requestId;
  res.setHeader('X-Request-ID', requestId);

  return requestId;
}
