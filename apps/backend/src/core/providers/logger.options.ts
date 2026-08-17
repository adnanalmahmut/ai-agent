import type { ConfigType } from '@nestjs/config';
import type { Params } from 'nestjs-pino';

import { appConfig, observabilityConfig } from '../../config';
import { assignRequestId } from './request-id';

export function createLoggerOptions(
  app: ConfigType<typeof appConfig>,
  observability: ConfigType<typeof observabilityConfig>,
): Params {
  return {
    pinoHttp: {
      level: observability.level,
      genReqId: (req, res) => assignRequestId(req, res),

      transport: observability.pretty
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:standard',
              ignore: 'pid,hostname',
            },
          }
        : undefined,

      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          // Defense in depth: mail variables and action URLs may contain
          // single-use verification or password-reset tokens.
          'variables',
          'actionUrl',
          '*.variables',
          '*.actionUrl',
        ],
        remove: true,
      },

      customProps: () => ({
        service: app.name,
        environment: app.env,
      }),

      autoLogging: {
        ignore: (req) =>
          req.url === '/api/health/live' || req.url === '/api/health/ready',
      },
    },
  };
}
