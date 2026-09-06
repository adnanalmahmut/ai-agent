import { Resend } from 'resend';

import type { ResendMailConfig } from '../config/mail.config';
import { formatSender, withTimeout } from './mail-transport';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery.port';

export class ResendNotificationDelivery implements NotificationDelivery {
  readonly idempotent = true;
  readonly sender: string;

  private readonly client: Resend;

  constructor(private readonly config: ResendMailConfig) {
    this.client = new Resend(config.apiKey);
    this.sender = formatSender(config.from);
  }

  async deliver(message: NotificationMessage): Promise<ExternalEffectOutcome> {
    let response: Awaited<ReturnType<Resend['emails']['send']>>;

    try {
      response = await withTimeout(
        this.client.emails.send(
          {
            from: this.sender,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          { idempotencyKey: message.idempotencyKey },
        ),
        this.config.timeoutMs,
        () => new Error('Resend did not respond in time'),
      );
    } catch {
      return { kind: 'unavailable' };
    }

    if (response.error) {
      return classify(response.error.name, response.error.statusCode);
    }

    if (!response.data?.id) {
      // A success with no identifier is a response this application cannot
      // reconstruct anything from. Treated as ambiguous rather than as sent.
      return { kind: 'unavailable' };
    }

    return { kind: 'accepted', providerMessageId: response.data.id };
  }
}

const REJECTED: ReadonlySet<string> = new Set([
  'validation_error',
  'missing_required_field',
  'invalid_parameter',
  'invalid_from_address',
  'invalid_attachment',
  'invalid_idempotency_key',
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'invalid_access',
  'not_found',
  'method_not_allowed',
  'invalid_region',
]);

function classify(
  name: string,
  statusCode: number | null,
): ExternalEffectOutcome {
  if (REJECTED.has(name)) return { kind: 'rejected' };

  if (
    statusCode !== null &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 409 &&
    statusCode !== 429
  ) {
    return { kind: 'rejected' };
  }

  return { kind: 'unavailable' };
}
