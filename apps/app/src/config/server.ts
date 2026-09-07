import 'server-only';

function apiOrigin(value: string | undefined): string {
  const candidate = value ?? 'http://127.0.0.1:3002';
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/') {
    throw new Error('PLATFORM_API_ORIGIN must be an http(s) origin without a path');
  }

  return url.origin;
}

export const serverConfig = {
  apiOrigin: apiOrigin(process.env.PLATFORM_API_ORIGIN),
} as const;
