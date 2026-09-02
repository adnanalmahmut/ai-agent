import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable } from '@nestjs/common';

import type { SesMailConfig } from '../config/mail.config';
import {
  formatSender,
  MailDeliveryError,
  type MailTransport,
} from './mail-transport';
import type { MailDeliveryResult, OutboundMail } from './mail.types';

/**
 * Delivery through Amazon SES v2.
 *
 * Credentials are handled by omission wherever possible: when the
 * configuration carries none, the client is constructed without a
 * `credentials` key and the SDK resolves them through its own chain —
 * environment, SSO, shared config, then the ECS/EC2 metadata service. That is
 * what lets a deployment run on a task role with short-lived credentials
 * instead of long-lived keys, and it is the reason this class never reads
 * `process.env` itself.
 *
 * Unlike Resend, the AWS SDK signals failure by throwing. Those exceptions
 * carry the full signed request in `$metadata` and `$response`, so none of the
 * original error reaches the message — only the SES error *name* and HTTP
 * status, both of which are stable and non-sensitive.
 */
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

/**
 * A safe, actionable summary of an AWS failure.
 *
 * Reads only the two stable identifiers — the exception name (`MessageRejected`,
 * `AccountSuspendedException`, `Throttling`) and the HTTP status. The SDK's own
 * `message` is skipped because it interpolates request details, and the whole
 * error object is preserved on `cause` for debugging without ever being logged.
 */
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
