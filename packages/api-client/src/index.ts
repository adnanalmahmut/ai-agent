/**
 * The shared boundary between this repository's applications and its API.
 *
 * What is here is what every consumer needs and none of them should own a
 * second copy of: the wire protocol for a response and its errors, the two
 * error types a caller distinguishes, and — through the subpaths — the
 * transports and the generated types.
 *
 * Deliberately not here: which endpoints exist, what they are called, and
 * what the application does with them. This package knows how to talk, not
 * what to say.
 *
 * Subpaths:
 *   `@repo/api-client/browser`    the browser transport
 *   `@repo/api-client/server`     the server transport (no framework)
 *   `@repo/api-client/generated`  the generated OpenAPI types
 *
 * This entry and `./browser` are safe in a browser bundle; neither imports a
 * server module, and `./server` is a separate subpath so that it cannot be
 * reached from one by accident.
 */
export {
  errorDetailLines,
  NO_ERROR_DETAILS,
  readApiError,
  unwrapEnvelope,
} from './protocol';
export type {
  ApiBusinessErrorDetails,
  ApiErrorDetails,
  ApiFieldError,
  ApiValidationErrorDetails,
} from './protocol';

export { ApiError, ApiUnavailableError } from './errors';
