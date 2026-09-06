import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
// Nodemailer's default `SentMessageInfo` is `any`. Naming the pooled SMTP
// variant — pooled because `pool: true` below — gives `info.messageId` a real
// type instead of silently opting this file out of type checking.
import type SMTPPool from 'nodemailer/lib/smtp-pool';

import type { SmtpMailConfig } from '../config/mail.config';
import {
  formatSender,
  MailDeliveryError,
  type MailTransport,
} from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

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

  onModuleDestroy(): void {
    this.transporter.close();
  }
}

function describe(error: unknown): string {
  const named = error as { code?: unknown; responseCode?: unknown };

  const code = typeof named?.code === 'string' ? named.code : 'UNKNOWN';
  const responseCode = named?.responseCode;

  return typeof responseCode === 'number'
    ? `SMTP delivery failed (${code}, response ${responseCode})`
    : `SMTP delivery failed (${code})`;
}
