/**
 * The parts of `window.location` that survive a language switch.
 *
 * Typed structurally rather than as `Location` so this stays a pure function
 * that a test can call without a DOM.
 */
export type PreservedLocationParts = {
  /** Leading `?` optional — `window.location.search` supplies one. */
  search?: string;
  /** Leading `#` optional — `window.location.hash` supplies one. */
  hash?: string;
};

/**
 * Builds the target passed to `router.replace` when the locale changes.
 *
 * Deliberately separate from the component: switching language must not
 * silently drop the reader's place on the page. The hash matters because the
 * page navigates by anchors (`#formatting`), and the query because filters and
 * tabs live there — both are easy to lose in a locale switch and hard to
 * notice, so the rule is stated here once and tested directly.
 *
 * The locale prefix is *not* this function's business: `router.replace`
 * applies whichever prefix the configured mode calls for, which is what keeps
 * the switcher identical under `always` and `as-needed`.
 */
export function localeSwitchHref(
  pathname: string,
  parts?: PreservedLocationParts,
): string {
  return `${pathname}${prefixed(parts?.search, '?')}${prefixed(parts?.hash, '#')}`;
}

/**
 * Empty stays empty — an unconditional `?` or `#` would turn a clean URL into
 * `/settings?#` on every switch.
 */
function prefixed(value: string | undefined, marker: '?' | '#'): string {
  if (!value || value === marker) return '';

  return value.startsWith(marker) ? value : `${marker}${value}`;
}
