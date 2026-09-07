export type RouteSearchParams = Record<
  string,
  string | string[] | undefined
>;

export function firstRouteParam(
  params: RouteSearchParams,
  key: string,
): string | undefined {
  const value = params[key];
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

export function routeSearchString(params: RouteSearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) search.append(key, item);
    }
  }
  return search.toString();
}
