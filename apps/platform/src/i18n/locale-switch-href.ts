export type PreservedLocationParts = {
  search?: string;
  hash?: string;
};

export function localeSwitchHref(
  pathname: string,
  parts?: PreservedLocationParts,
): string {
  return `${pathname}${prefixed(parts?.search, '?')}${prefixed(parts?.hash, '#')}`;
}

function prefixed(value: string | undefined, marker: '?' | '#'): string {
  if (!value || value === marker) return '';

  return value.startsWith(marker) ? value : `${marker}${value}`;
}
