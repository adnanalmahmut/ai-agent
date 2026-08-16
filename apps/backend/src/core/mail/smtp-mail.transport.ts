import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
// Nodemailer's default `SentMessageInfo` is `any`. Naming the pooled SMTP
// variant — pooled because `pool: true` below — gives `info.messageId` a real
// type instead of silently opting this file out of type checking.
import type SMTPPool from 'nodemailer/lib/smtp-pool';

import type { SmtpMailConfig } from '../../config/mail.config';
import {
  formatSender,
  MailDeliveryError,
  type MailTransport,
} from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

/**
 * Delivery over SMTP, via Nodemailer.
 *
 * The transporter is created once and pooled. Unlike an HTTP provider, SMTP
 * pays for a TCP connection, a TLS handshake and an authentication round-trip
 * on every connection — building a transporter per message would repeat all
 * three for each email and, under load, exhaust the server's connection limit.
 *
 * `auth` is omitted entirely when no credentials are configured, rather than
 * passed as an empty object: Nodemailer treats a present `auth` as an
 * instruction to authenticate, and a relay that accepts anonymous submission
 * would then refuse the session.
 */
@Injectable()
export class SmtpMailTransport implements MailTransport, OnModuleDestroy {
  private readonly transporter: Transporter<SMTPPool.SentMessageInfo>;

  constructor(private readonly config: SmtpMailConfig) {
    this.transporter = createTransport({
      host: config.host,
      port: config.port,
      // `true` means TLS from the first byte (usually 465). `false` still
      // upgrades opportunistically via STARTTLS where the server offers it.
      secure: config.secure,
      pool: true,
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs,
      ...(config.auth
        ? { auth: { user: config.auth.user, pass: config.auth.password } }
        : {}),
    });
  }

  async send(mail: OutboundMail): Promise<MailDeliveryResult> {
    const info = await this.transporter
      .sendMail({
        from: formatSender(mail.from),
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
      })
      .catch((error: unknown) => {
        throw new MailDeliveryError('smtp', describe(error), error);
      });

    return { provider: 'smtp', messageId: info.messageId };
  }

  /**
   * Pooled connections keep the process alive. Closing them on shutdown is
   * what lets the application exit instead of hanging on an idle socket.
   */
  onModuleDestroy(): void {
    this.transporter.close();
  }
}

/**
 * A safe summary of an SMTP failure.
 *
 * Nodemailer errors expose a stable `code` (`EAUTH`, `ECONNECTION`,
 * `ETIMEDOUT`, `EENVELOPE`) and the server's `responseCode`. The server's
 * `response` text is deliberately not included: relays routinely echo the
 * envelope — and, on authentication failures, the username — back in it.
 */
function describe(error: unknown): string {
  const named = error as { code?: unknown; responseCode?: unknown };

  const code = typeof named?.code === 'string' ? named.code : 'UNKNOWN';
  const responseCode = named?.responseCode;

  return typeof responseCode === 'number'
    ? `SMTP delivery failed (${code}, response ${responseCode})`
    : `SMTP delivery failed (${code})`;
}
