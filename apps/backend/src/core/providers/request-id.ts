import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Assigns the application's request correlation ID.
 *
 * Reuses an existing or incoming ID; otherwise generates a new one.
 * Shared by the standard HTTP pipeline and authentication requests.
 */
export function assignRequestId(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  if ((req as any).id) {
    return (req as any).id;
  }

  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming.trim()
      : `req_${randomUUID()}`;

  (req as any).id = requestId;
  res.setHeader('X-Request-ID', requestId);

  return requestId;
}
