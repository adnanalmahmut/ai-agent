import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';

import { formatSender } from './mail-transport';
import { maskEmail } from './mail-redaction';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery.port';

/**
 * The development driver: nothing leaves the process.
 *
 * Idempotent trivially, and honestly so — the "provider identifier" is a
 * digest of the idempotency key, so a replay of the same effect produces the
 * same id exactly as a real provider's replay would. That keeps the worker's
 * observable behaviour identical across drivers, which is what lets the same
 * end-to-end test mean the same thing in CI and against Resend.
 *
 * The log line carries the masked recipient and the subject length, not the
 * subject and not the body: this driver runs where developers read logs, and
 * a model-written message addressed to a real member is still tenant material.
 */
export class LogNotificationDelivery implements NotificationDelivery {
  readonly idempotent = true;
  readonly sender: string;

  constructor(
    from: { address: string; name: string },
    private readonly logger: PinoLogger,
  ) {
    this.sender = formatSender(from);
    this.logger.setContext(LogNotificationDelivery.name);
  }

  deliver(message: NotificationMessage): Promise<ExternalEffectOutcome> {
    const providerMessageId = `log:${createHash('sha256')
      .update(message.idempotencyKey)
      .digest('hex')
      .slice(0, 32)}`;

    this.logger.info(
      {
        event: 'notification.delivered',
        driver: 'log',
        to: maskEmail(message.to),
        subjectLength: message.subject.length,
        bodyLength: message.text.length,
        providerMessageId,
      },
      'Notification delivered to the log driver',
    );

    return Promise.resolve({ kind: 'accepted', providerMessageId });
  }
}
