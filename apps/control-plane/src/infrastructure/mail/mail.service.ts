import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../config';
import { maskEmail } from './mail-redaction';
import { MailRendererService } from './mail-renderer.service';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import type { MailDeliveryResult, MailJob, OutboundMail } from './mail.types';

@Injectable()
export class MailService {
  constructor(
    private readonly renderer: MailRendererService,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(mailConfig.KEY)
    private readonly config: ConfigType<typeof mailConfig>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MailService.name);
  }

  async send(job: MailJob): Promise<MailDeliveryResult> {
    return this.transport.send(this.toOutboundMail(job));
  }

  dispatch(job: MailJob): void {
    void this.send(job).catch((error: unknown) => {
      this.logger.error(
        {
          event: 'mail.failed',
          template: job.template,
          locale: job.locale,
          to: maskEmail(job.to),
          // A fixed projection, never the error object. Provider SDK errors
          // carry the originating request — headers, query string, sometimes
          // the key that signed it — and `MailDeliveryError.cause` holds that
          // error verbatim. Name and message are enough to alert on; the rest
          // stays on the rejection, reachable in a debugger.
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage:
            error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to deliver mail',
      );
    });
  }

  private toOutboundMail(job: MailJob): OutboundMail {
    const rendered = this.renderer.render(job);

    return {
      to: job.to,
      from: this.config.from,
      subject: rendered.subject,
      html: rendered.html,
      meta: {
        template: job.template,
        locale: rendered.locale,
        direction: rendered.direction,
      },
    };
  }
}
