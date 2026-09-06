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
