/**
 * The platform API speaks one wire protocol whichever side of the application
 * reads it: a success envelope around the payload, and a failure body whose
 * code and details may sit at the top level or nested under `error`.
 *
 * Transport stays with each caller — the browser sends credentials to a
 * same-origin path, the server forwards a cookie to the API origin with no
 * store — but the reading of what came back is one thing, kept here so the two
 * cannot drift into disagreeing about the same response.
 *
 * Nothing in this module touches the network or the request, so it is safe on
 * both sides of the `server-only` boundary.
 */

/** A failure the caller can fix in one named field of the request. */
export type ApiFieldError = {
  field: string;
  code: string;
  message: string;
};

/**
 * What a failing response said about itself, in the shape the interface can
 * act on.
 *
 * The API declares `error.details` as a tagged object: a validated request
 * that was refused, or a domain rule that said no. That tag is the whole point
 * — a screen showing field errors and a screen showing a refusal are different
 * screens, and telling them apart by whether the wire happened to carry an
 * array is how field errors were silently dropped before the tag existed.
 *
 * `none` is the third case and not an absence: a body may be missing,
 * malformed, or not JSON at all, and the status alone still describes the
 * refusal.
 */
export type ApiErrorDetails =
  | { kind: 'none' }
  | { kind: 'validation'; fields: ApiFieldError[]; messages: string[] }
  | { kind: 'business'; reason?: string };

export const NO_ERROR_DETAILS: ApiErrorDetails = { kind: 'none' };

/**
 * The lines a screen can put under its own sentence, in the order the server
 * meant them. Field messages first, because a caller reads the specific
 * failure before the general one.
 *
 * These describe the rule and never the submitted value, which is what makes
 * them safe to render.
 */
export function errorDetailLines(details: ApiErrorDetails): string[] {
  if (details.kind === 'validation') {
    return [...details.fields.map((field) => field.message), ...details.messages];
  }

  if (details.kind === 'business' && details.reason !== undefined) {
    return [details.reason];
  }

  return [];
}

/**
 * Returns the payload the server wrapped, or the body untouched when it never
 * wrapped one — an unenveloped endpoint is passed through as it stands.
 */
export function unwrapEnvelope(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;

  const record = body as Record<string, unknown>;

  return record.success === true && 'data' in record ? record.data : body;
}

/**
 * Reads what a failing response says about itself. A body that is absent,
 * malformed, or not JSON at all is not itself a failure: the status alone
 * still describes the refusal, so the caller gets an empty reading rather than
 * a parse error thrown over the top of the real one.
 */
export async function readApiError(
  response: Response,
): Promise<{ code: string | undefined; details: ApiErrorDetails }> {
  try {
    const body: unknown = await response.json();

    if (typeof body !== 'object' || body === null) {
      return { code: undefined, details: NO_ERROR_DETAILS };
    }

    const record = body as Record<string, unknown>;
    const nested = record.error;
    const source =
      typeof nested === 'object' && nested !== null
        ? (nested as Record<string, unknown>)
        : record;

    return {
      code: typeof source.code === 'string' ? source.code : undefined,
      details: readApiErrorDetails(source.details),
    };
  } catch {
    return { code: undefined, details: NO_ERROR_DETAILS };
  }
}

/**
 * Keeps only the shapes the interface knows how to show. A field of the wrong
 * type is dropped rather than passed on, so a rendering never has to defend
 * itself against the wire.
 *
 * Both of the shapes this API published before it declared a tag are still
 * read, because a rollback to an older release is a supported operation and
 * the running interface has to survive one: the request pipe used to send a
 * bare array of field errors, and a service validating its own input used to
 * send `{ issues }`. Neither is produced any more, and neither is guessed at
 * beyond what it plainly is.
 */
function readApiErrorDetails(value: unknown): ApiErrorDetails {
  if (Array.isArray(value)) {
    // Legacy: the request pipe's field errors, before they were tagged.
    return { kind: 'validation', fields: readFieldErrors(value), messages: [] };
  }

  if (typeof value !== 'object' || value === null) return NO_ERROR_DETAILS;

  const record = value as Record<string, unknown>;

  if (record.kind === 'validation') {
    return {
      kind: 'validation',
      fields: readFieldErrors(record.fields),
      messages: readMessages(record.messages),
    };
  }

  if (record.kind === 'business') {
    return typeof record.reason === 'string'
      ? { kind: 'business', reason: record.reason }
      : { kind: 'business' };
  }

  // Legacy: an untagged bag, from a release that predates the contract.
  const messages = readMessages(record.issues);
  if (messages.length > 0) return { kind: 'validation', fields: [], messages };

  if (typeof record.reason === 'string') {
    return { kind: 'business', reason: record.reason };
  }

  return NO_ERROR_DETAILS;
}

/**
 * All or nothing, here and in `readMessages`: a list with one entry of the
 * wrong shape is a list from a server that is not speaking this contract, and
 * showing the half of it that happens to parse asserts more about the failure
 * than is known.
 */
function readFieldErrors(value: unknown): ApiFieldError[] {
  if (!Array.isArray(value)) return [];

  return value.every(isFieldError) ? (value as ApiFieldError[]) : [];
}

function isFieldError(value: unknown): value is ApiFieldError {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.field === 'string' &&
    typeof record.code === 'string' &&
    typeof record.message === 'string'
  );
}

function readMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : [];
}
