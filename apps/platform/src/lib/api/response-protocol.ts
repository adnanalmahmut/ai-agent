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

export type ApiErrorDetails = {
  issues?: string[];
  reason?: string;
};

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
      return { code: undefined, details: {} };
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
    return { code: undefined, details: {} };
  }
}

/**
 * Keeps only the shapes the interface knows how to show. A field of the wrong
 * type is dropped rather than passed on, so a rendering never has to defend
 * itself against the wire.
 */
function readApiErrorDetails(value: unknown): ApiErrorDetails {
  if (typeof value !== 'object' || value === null) return {};

  const record = value as Record<string, unknown>;
  const details: ApiErrorDetails = {};

  if (
    Array.isArray(record.issues) &&
    record.issues.every((issue) => typeof issue === 'string')
  ) {
    details.issues = record.issues as string[];
  }

  if (typeof record.reason === 'string') details.reason = record.reason;

  return details;
}
