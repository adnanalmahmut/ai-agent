export function firstParam(
  params: URLSearchParams,
  key: string,
): string | undefined {
  const value = params.get(key);

  if (value === null) return undefined;

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

export function firstParamOf(url: URL, key: string): string | undefined {
  return firstParam(url.searchParams, key);
}
