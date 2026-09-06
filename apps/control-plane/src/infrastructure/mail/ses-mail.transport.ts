import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';

import type { SesMailConfig } from '../config/mail.config';
import {
  formatSender,
  MailDeliveryError,
  type MailTransport,
} from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

@Injectable()
export class SesMailTransport implements MailTransport {
  private readonly client: SESv2Client;

  constructor(private readonly config: SesMailConfig) {
    this.client = new SESv2Client({
      region: config.region,
      // `requestTimeout` bounds the HTTP request itself, which is better than
      // racing a promise: the socket is actually torn down.
      requestHandler: { requestTimeout: config.timeoutMs },
      ...(config.credentials
        ? {
            credentials: {
              accessKeyId: config.credentials.accessKeyId,
              secretAccessKey: config.credentials.secretAccessKey,
              sessionToken: config.credentials.sessionToken,
            },
          }
        : {}),
    });
  }

  async send(mail: OutboundMail): Promise<MailDeliveryResult> {
    const command = new SendEmailCommand({
      FromEmailAddress: formatSender(mail.from),
      Destination: { ToAddresses: [mail.to] },
      Content: {
        Simple: {
          Subject: { Data: mail.subject, Charset: 'UTF-8' },
          // UTF-8 is not optional here: the Arabic templates would otherwise
          // be transmitted in a charset that cannot represent them.
          Body: { Html: { Data: mail.html, Charset: 'UTF-8' } },
        },
      },
    });

    const response = await this.client.send(command).catch((error: unknown) => {
      throw new MailDeliveryError('ses', describe(error), error);
    });

    if (!response.MessageId) {
      throw new MailDeliveryError('ses', 'SES returned no message id');
    }

    return { provider: 'ses', messageId: response.MessageId };
  }
}

function describe(error: unknown): string {
  const named = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  const name = typeof named?.name === 'string' ? named.name : 'UnknownError';
  const status = named?.$metadata?.httpStatusCode;

  return typeof status === 'number'
    ? `SES rejected the message (${name}, status ${status})`
    : `SES request failed (${name})`;
}
