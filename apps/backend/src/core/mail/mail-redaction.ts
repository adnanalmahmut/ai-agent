/**
 * What may safely appear in a log line about a message.
 *
 * This lives in its own file rather than beside its two callers because a
 * redaction rule that exists in two copies is a rule that will eventually be
 * fixed in one of them. It is the only reason the mail module has an eighth
 * file.
 */

/**
 * `someone@example.com` → `s******e@example.com`.
 *
 * Enough to correlate a delivery with a support report, not enough to harvest
 * an address list out of aggregated logs. Anything without a local part is
 * reported as `***` rather than passed through, so a malformed address cannot
 * become the exception that logs itself in full.
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';

  const local = address.slice(0, at);
  const domain = address.slice(at);

  if (local.length <= 2) return `${'*'.repeat(local.length)}${domain}`;

  return `${local[0]}${'*'.repeat(local.length - 2)}${local.at(-1)}${domain}`;
}
