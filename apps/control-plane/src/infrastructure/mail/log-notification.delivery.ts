import { createHash } from 'node:crypto';
import { PinoLogger } from 'nestjs-pino';

import { formatSender } from './mail-transport';
import { maskEmail } from './mail-redaction';
import type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery.port';

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
