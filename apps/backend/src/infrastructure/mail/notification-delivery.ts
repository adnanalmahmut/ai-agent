import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../config';
import { LogNotificationDelivery } from './log-notification.delivery';
import { formatSender } from './mail-transport';
import {
  NOTIFICATION_DELIVERY,
  type ExternalEffectOutcome,
  type NotificationDelivery,
} from './notification-delivery.port';
import { ResendNotificationDelivery } from './resend-notification.delivery';

/**
 * A driver this application knows how to send *auth* mail through but cannot
 * make idempotent. SES and SMTP have no request-level idempotency key, so the
 * governed effect is unavailable rather than best-effort.
 */
class UnsupportedNotificationDelivery implements NotificationDelivery {
  readonly idempotent = false;
  readonly sender: string;

  constructor(from: { address: string; name: string }) {
    this.sender = formatSender(from);
  }

  deliver(): Promise<ExternalEffectOutcome> {
    // Never reached: the tool refuses on `idempotent` before any attempt.
    // Answered honestly all the same: nothing was attempted, and nothing may be.
    return Promise.resolve({ kind: 'rejected' });
  }
}

export function createNotificationDelivery(
  config: ConfigType<typeof mailConfig>,
  logger: PinoLogger,
): NotificationDelivery {
  switch (config.driver) {
    case 'log':
      return new LogNotificationDelivery(config.from, logger);

    case 'resend':
      return new ResendNotificationDelivery(config);

    case 'ses':
    case 'smtp':
      return new UnsupportedNotificationDelivery(config.from);
  }
}

/**
 * The delivery port for governed side effects, composed from the mail driver.
 *
 * Its own module rather than a provider on `MailModule`, because it is needed
 * by the worker and `MailModule` is not: the renderer there depends on the
 * request-scoped i18n stack the worker deliberately does not carry. This
 * module needs only the mail configuration and a logger, so both composition
 * roots can import it.
 */
@Module({
  providers: [
    {
      provide: NOTIFICATION_DELIVERY,
      inject: [mailConfig.KEY, PinoLogger],
      useFactory: createNotificationDelivery,
    },
  ],
  exports: [NOTIFICATION_DELIVERY],
})
export class NotificationDeliveryModule {}
