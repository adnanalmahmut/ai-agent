import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';

import type { httpConfig } from '../config';

export function configureTrustedProxy(
  app: Pick<NestExpressApplication, 'set'>,
  config: Pick<ConfigType<typeof httpConfig>, 'trustProxyHops'>,
): void {
  app.set('trust proxy', config.trustProxyHops);
}

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
