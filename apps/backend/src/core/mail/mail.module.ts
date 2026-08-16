import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../../config';
import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MailRendererService } from './mail-renderer.service';
import { MailService } from './mail.service';
import { ResendMailTransport } from './resend-mail.transport';
import { SesMailTransport } from './ses-mail.transport';
import { SmtpMailTransport } from './smtp-mail.transport';

/**
 * The one place a driver name becomes a class.
 *
 * `MailService` deliberately contains no branch on the provider; if it did,
 * every new driver would edit the file every feature depends on. Here the
 * branch is a composition detail, and the `switch` is exhaustive over
 * `MailDriver`, so forgetting a case is a compile error rather than an
 * `undefined` at the first send.
 */
function createMailTransport(
  config: ConfigType<typeof mailConfig>,
  logger: PinoLogger,
): MailTransport {
  switch (config.driver) {
    case 'log':
      return new LogMailTransport(config, logger);

    case 'resend':
      return new ResendMailTransport(config);

    case 'ses':
      return new SesMailTransport(config);

    case 'smtp':
      return new SmtpMailTransport(config);
  }
}

/**
 * Localized, delivered mail.
 *
 * The public surface is `MailService` and the renderer. `MAIL_TRANSPORT` is
 * *not* exported: a consumer able to inject the transport could send a message
 * that skipped rendering, locale resolution, and the failure handling that
 * `MailService` exists to provide, which would make the abstraction advisory
 * rather than real.
 */
@Module({
  providers: [
    MailRendererService,
    MailService,
    {
      provide: MAIL_TRANSPORT,
      inject: [mailConfig.KEY, PinoLogger],
      useFactory: createMailTransport,
    },
  ],
  exports: [MailService, MailRendererService],
})
export class MailModule {}
