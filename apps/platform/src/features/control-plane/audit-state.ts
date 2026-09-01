/**
 * The display gate for a managed secret's encryption key version.
 *
 * `keyVersion` is the one field the audit table renders *from* the
 * server-supplied `before`/`after` payload instead of projecting to a term the
 * client chose. That makes it a deliberate exception to the rule the rest of
 * `stateSummary` follows, and the point of this module is that the exception has
 * boundaries written down in one testable place rather than living as a `typeof`
 * check at the call site.
 *
 * ## What the gate does
 *
 * It admits only the shape the backend's own `APP_ENCRYPTION_ACTIVE_KEY_VERSION`
 * grammar admits — lowercase letters, digits, dot, underscore and hyphen, not
 * beginning or ending in punctuation — under a cap tighter than that grammar's
 * 64. So the value cannot carry markup or quotes, cannot introduce whitespace or
 * newlines, and cannot contain the bidirectional-format characters that would
 * let it reorder the line it is rendered into. React escapes text anyway; this is
 * the layer that keeps the cell from becoming a place where arbitrary text is
 * displayed at all.
 *
 * ## What the gate does not do
 *
 * It is **not** a secrecy check and must not be cited as one. A lowercase,
 * hyphenated token inside the cap is admitted whatever it happens to mean — see
 * the test that asserts exactly that, on purpose. What keeps a credential out of
 * this column is upstream: the rotation service records a version only after
 * `ManagedSecretKeyring.open` succeeded, and resolution requires that version to
 * be one the process was configured with. The gate bounds the value's *shape*,
 * not its meaning, and `docs/security.md` states the residual risk in those
 * terms.
 *
 * A non-conforming value is replaced, never shortened. Truncating would defeat
 * the cap it is meant to enforce: a prefix of something unexpected is still that
 * thing's prefix.
 */

/**
 * Shorter than the backend's 64 deliberately. A key version is an operator's own
 * label for a rollout — `v2`, `2026-08`, `keyver-alpha` — and nothing legitimate
 * needs more room than this. The tighter bound is the cheap half of the gate.
 */
const MAX_DISPLAYED_KEY_VERSION_LENGTH = 24;

/** Mirrors `keyVersionSchema` in `apps/backend/src/config/encryption.config.ts`. */
const DISPLAYABLE_KEY_VERSION = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * The version to render, or `null` when this build will not display it.
 *
 * `null` covers three different situations the caller distinguishes: the entry
 * records no version, records something that is not a string at all, or records
 * a string outside the displayable shape. Only the first is ordinary.
 */
export function displayableKeyVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_DISPLAYED_KEY_VERSION_LENGTH) return null;

  return DISPLAYABLE_KEY_VERSION.test(value) ? value : null;
}

/**
 * Whether the entry recorded a version at all.
 *
 * Separates "this action says nothing about the seal" — configure, rotate and
 * remove omit the field — from "a version is recorded but was not displayable".
 * Collapsing the two would hide a rejected value behind the label a normal row
 * gets, which is the one outcome an operator reading a key rollout should not be
 * shown.
 */
export function recordsKeyVersion(value: unknown): boolean {
  return value !== undefined && value !== null;
}
