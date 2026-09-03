/**
 * Reading a single value out of a query string.
 *
 * A key can appear once, many times, or not at all, and the multiple case is
 * not hypothetical: `?returnTo=/safe&returnTo=https://evil.example` is a real
 * parameter-pollution shape. `URLSearchParams.get` already answers with the
 * *first* occurrence, which is the value a reader of the URL would expect and
 * the safer of the two choices — so this wrapper's job is only to turn the
 * `null` it uses for "absent" into the `undefined` the rest of the application
 * speaks, and to trim a value that is present but blank.
 *
 * Small enough to inline, and deliberately not inlined: every call site that
 * wrote its own `?? undefined` would be a call site that might write `getAll`
 * instead.
 */
export function firstParam(
  params: URLSearchParams,
  key: string,
): string | undefined {
  const value = params.get(key);

  if (value === null) return undefined;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

/** The same read, from a full URL. Convenient at request boundaries. */
export function firstParamOf(url: URL, key: string): string | undefined {
  return firstParam(url.searchParams, key);
}
