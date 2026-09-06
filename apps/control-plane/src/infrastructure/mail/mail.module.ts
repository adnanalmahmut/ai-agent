import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../config';
import { LogMailTransport } from './log-mail.transport';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import { MailRendererService } from './mail-renderer.service';
import { MailService } from './mail.service';
import { ResendMailTransport } from './resend-mail.transport';
import { SesMailTransport } from './ses-mail.transport';
import { SmtpMailTransport } from './smtp-mail.transport';

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
