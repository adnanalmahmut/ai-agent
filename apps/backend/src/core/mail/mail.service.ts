import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../../config';
import { maskEmail } from './mail-redaction';
import { MailRendererService } from './mail-renderer.service';
import { MAIL_TRANSPORT, type MailTransport } from './mail-transport';
import type { MailDeliveryResult, MailJob, OutboundMail } from './mail.types';

/**
 * Orchestrates outbound mail: render, address, deliver.
 *
 * It knows *that* there is a transport and nothing about *which* one — no
 * driver name appears in this file. Selection happens once, in `MailModule`,
 * so adding a provider never reaches application code.
 */
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

  /**
   * Delivers and reports the outcome. Rejects with `MailDeliveryError` if the
   * transport fails.
   *
   * For callers that need to know whether the message went out — an operator
   * action, a test. Callers on a request path that must not be blocked or
   * broken by a provider outage want `dispatch` instead.
   */
  async send(job: MailJob): Promise<MailDeliveryResult> {
    return this.transport.send(this.toOutboundMail(job));
  }

  /**
   * Sends without blocking the caller and without ever throwing at it.
   *
   * Two problems are being solved at once. Awaiting a send inside an
   * authentication callback makes the response time depend on whether the
   * address exists, which is a user-enumeration oracle; and letting a provider
   * outage reject into that callback would fail a signup for a reason that has
   * nothing to do with signing up.
   *
   * A bare `void this.send(job)` would fix the first and create a third: an
   * unhandled rejection. The catch lives here, once, instead of at every call
   * site where it could be forgotten.
   *
   * Known limitation, stated rather than hidden: if the process dies before
   * delivery the message is lost. This method is the seam where a queue
   * replaces the direct call, at which point that stops being true — and no
   * caller changes.
   */
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
