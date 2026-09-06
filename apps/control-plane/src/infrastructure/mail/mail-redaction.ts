export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';

  const local = address.slice(0, at);
  const domain = address.slice(at);

  if (local.length <= 2) return `${'*'.repeat(local.length)}${domain}`;

  return `${local[0]}${'*'.repeat(local.length - 2)}${local.at(-1)}${domain}`;
}
