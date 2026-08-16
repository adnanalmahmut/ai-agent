import type { ConfigType } from '@nestjs/config';
import type { Params } from 'nestjs-pino';

import { appConfig, observabilityConfig } from '../../config';

export function createLoggerOptions(
  app: ConfigType<typeof appConfig>,
  observability: ConfigType<typeof observabilityConfig>,
): Params {
  return {
    pinoHttp: {
      level: observability.level,

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
          // Mail transports log an explicit whitelist and never these, but a
          // redaction rule costs nothing and covers the case where someone
          // adds a log line without reading the policy: `actionUrl` carries a
          // single-use verification or password-reset token, and the variable
          // bag is where it comes from.
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
        ignore: (req) => req.url === '/health',
      },
    },
  };
}
