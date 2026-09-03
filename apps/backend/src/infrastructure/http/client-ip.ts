import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';

import type { httpConfig } from '../config';

/** Applies the only supported Express forwarded-header trust policy. */
export function configureTrustedProxy(
  app: Pick<NestExpressApplication, 'set'>,
  config: Pick<ConfigType<typeof httpConfig>, 'trustProxyHops'>,
): void {
  app.set('trust proxy', config.trustProxyHops);
}

/**
 * Better Auth reads its configured header directly rather than Express
 * `req.ip`. Local and test requests do not pass through Nginx, so overwrite
 * both forwarded identity headers with the socket peer before Better Auth sees
 * them. In staging/production, host Nginx performs the same overwrite and the
 * application ports accept traffic only from loopback.
 *
 * This function never parses a forwarded chain.
 */
export function overwriteDirectClientIpHeaders(
  request: IncomingMessage,
  overwrite: boolean,
): void {
  if (!overwrite) return;

  const socketAddress = request.socket.remoteAddress;
  if (!socketAddress) {
    delete request.headers['x-real-ip'];
    delete request.headers['x-forwarded-for'];
    return;
  }

  request.headers['x-real-ip'] = socketAddress;
  request.headers['x-forwarded-for'] = socketAddress;
}
