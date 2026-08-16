import { Injectable } from '@nestjs/common';
import { Resend } from 'resend';

import type { ResendMailConfig } from '../../config/mail.config';
import {
  formatSender,
  MailDeliveryError,
  withTimeout,
  type MailTransport,
} from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

/**
 * Delivery through Resend's HTTP API.
 *
 * Two things about this SDK shape the implementation:
 *
 * 1. it does **not** throw on API errors — it resolves `{ data, error }`, so a
 *    `try`/`catch` alone would treat a rejected send as a success. The error
 *    branch is checked explicitly, and `catch` is left to cover transport-level
 *    failures (DNS, TLS, socket) which do still throw;
 * 2. it exposes no request timeout, so one is imposed around the call.
 */
@Injectable()
export class ResendMailTransport implements MailTransport {
  private readonly client: Resend;

  constructor(private readonly config: ResendMailConfig) {
    // Constructed once. The client is a thin wrapper over `fetch`, but
    // rebuilding it per message would still discard connection reuse.
    this.client = new Resend(config.apiKey);
  }

  async send(mail: OutboundMail): Promise<MailDeliveryResult> {
    const response = await withTimeout(
      this.client.emails.send({
        from: formatSender(mail.from),
        to: [mail.to],
        subject: mail.subject,
        html: mail.html,
      }),
      this.config.timeoutMs,
      () =>
        new MailDeliveryError(
          'resend',
          `Resend did not respond within ${this.config.timeoutMs}ms`,
        ),
    ).catch((error: unknown) => {
      // Reached for network-level failures and for the timeout above.
      if (error instanceof MailDeliveryError) throw error;

      throw new MailDeliveryError(
        'resend',
        'Resend request failed before a response was received',
        error,
      );
    });

    if (response.error) {
      // The message is built from Resend's *stable* error code and HTTP
      // status, never from its prose: `error.message` is provider-generated
      // and can quote back the payload it rejected — including the recipient.
      // The raw error is preserved on `cause`, which the logging policy in
      // `MailService.dispatch` never serializes.
      throw new MailDeliveryError(
        'resend',
        `Resend rejected the message (${response.error.name}, status ${response.error.statusCode ?? 'unknown'})`,
        response.error,
      );
    }

    if (!response.data) {
      throw new MailDeliveryError(
        'resend',
        'Resend returned neither an error nor a message id',
      );
    }

    return { provider: 'resend', messageId: response.data.id };
  }
}
