import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const IS_RAW_RESPONSE_KEY = 'isRawResponse';

/**
 * Opts out an endpoint from `ResponseInterceptor` JSON envelope wrapping.
 *
 * Use for protocol endpoints such as Server-Sent Events (`text/event-stream`),
 * file downloads, or binary streams where wrapping in `{ success: true, data }`
 * would violate the protocol.
 *
 * Note: HTTP 204 No Content and `/api/auth/*` routes are bypassed automatically;
 * `@RawResponse()` is for explicit protocol-level bypasses on `/api/*` routes.
 */
export const RawResponse = (): CustomDecorator<string> =>
  SetMetadata(IS_RAW_RESPONSE_KEY, true);
