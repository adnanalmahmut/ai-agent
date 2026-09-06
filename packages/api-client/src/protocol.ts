/**
 * The API speaks one wire protocol whichever side of whichever application
 * reads it: a success envelope around the payload, and a failure body whose
 * code and details may sit at the top level or nested under `error`.
 *
 * Transport differs by caller — the browser sends credentials to a same-origin
 * path, the server forwards a cookie to the API origin with no store — but the
 * reading of what came back is one thing, kept here so that no two callers can
 * drift into disagreeing about the same response.
 *
 * Nothing in this module touches the network, the request, or any framework,
 * so it is safe wherever it is imported.
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
export type ApiValidationErrorDetails = {
  kind: 'validation';
  fields: ApiFieldError[];
  messages: string[];
};

/**
 * A domain refusal, with whatever the endpoint documents alongside it. The
 * keys are open because the API declares them open: an endpoint that adds one
 * is not changing this contract, and a reader that kept only the keys it had
 * heard of would drop the new one without saying so. `reason` is named because
 * it is the one key by convention, not because it is the only one allowed.
 */
export type ApiBusinessErrorDetails = {
  kind: 'business';
  reason?: string;
  [key: string]: unknown;
};

export type ApiErrorDetails =
  { kind: 'none' } | ApiValidationErrorDetails | ApiBusinessErrorDetails;

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
    return [
      ...details.fields.map((field) => field.message),
      ...details.messages,
    ];
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

  if (record.kind === 'business') return readBusinessDetails(record);

  // Legacy: an untagged bag, from a release that predates the contract.
  const messages = readMessages(record.issues);
  if (messages.length > 0) return { kind: 'validation', fields: [], messages };

  if (typeof record.reason === 'string') {
    return { kind: 'business', reason: record.reason };
  }

  return NO_ERROR_DETAILS;
}

/**
 * How deep a business detail may nest, and what may be in it. The same rule
 * the API applies on the way out, applied again on the way in: JSON scalars,
 * plain objects and arrays of those, and nothing else.
 *
 * Reading it a second time is not redundant. A response body is whatever
 * arrived, and a screen that renders one should not have to ask whether the
 * thing it is holding is a value or a graph.
 */
const MAX_DETAIL_DEPTH = 4;

function readBusinessDetails(
  record: Record<string, unknown>,
): ApiBusinessErrorDetails {
  const details: ApiBusinessErrorDetails = { kind: 'business' };

  for (const [key, value] of Object.entries(record)) {
    // Set above, and not something the wire gets a say in.
    if (key === 'kind') continue;

    const kept = readBusinessValue(value, 0);
    if (kept !== undefined) details[key] = kept;
  }

  // Typed because it is the key every screen reaches for; dropped rather than
  // carried when the wire made it something other than a sentence.
  if (typeof details.reason !== 'string') delete details.reason;

  return details;
}

function readBusinessValue(value: unknown, depth: number): unknown {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }

  if (depth >= MAX_DETAIL_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value
      .map((item) => readBusinessValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }

  if (isPlainObject(value)) {
    const kept: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      const read = readBusinessValue(nested, depth + 1);
      if (read !== undefined) kept[key] = read;
    }

    return kept;
  }

  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
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
