import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { LogMailConfig } from '../config/mail.config';
import { maskEmail } from './mail-redaction';
import type { MailTransport } from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

const DUMP_DIRECTORY = '.tmp/mail';

@Injectable()
export class LogMailTransport implements MailTransport {
  constructor(
    private readonly config: LogMailConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LogMailTransport.name);

    // The dump files contain live tokens. Rather than trusting that nobody
    // sets this in production, refuse to construct — a boot failure naming the
    // variable is a far better outcome than a directory of working
    // account-takeover links on a production disk.
    if (config.writeHtml && process.env.NODE_ENV === 'production') {
      throw new Error(
        'MAIL_LOG_WRITE_HTML must not be enabled in production: rendered mail contains single-use auth tokens.',
      );
    }
  }

  async send(mail: OutboundMail): Promise<MailDeliveryResult> {
    if (this.config.writeHtml) {
      await this.writeHtmlDump(mail);
    }

    this.logger.info(
      {
        event: 'mail.sent',
        provider: 'log',
        template: mail.meta.template,
        locale: mail.meta.locale,
        direction: mail.meta.direction,
        to: maskEmail(mail.to),
        subject: mail.subject,
        htmlBytes: Buffer.byteLength(mail.html, 'utf8'),
      },
      'Mail delivered to the log driver',
    );

    return { provider: 'log' };
  }

  private async writeHtmlDump(mail: OutboundMail): Promise<void> {
    const directory = path.join(process.cwd(), DUMP_DIRECTORY);
    const name = `${Date.now()}-${mail.meta.template}-${mail.meta.locale}.html`;

    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, sanitize(name)), mail.html, 'utf8');
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}
