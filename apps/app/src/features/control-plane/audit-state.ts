const MAX_DISPLAYED_KEY_VERSION_LENGTH = 24;

const DISPLAYABLE_KEY_VERSION = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export function displayableKeyVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_DISPLAYED_KEY_VERSION_LENGTH) return null;

  return DISPLAYABLE_KEY_VERSION.test(value) ? value : null;
}

export function recordsKeyVersion(value: unknown): boolean {
  return value !== undefined && value !== null;
}
