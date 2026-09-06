import { Inject, Injectable } from '@nestjs/common';

import {
  type SideEffectDeliveryCommand,
  type SideEffectDeliveryPort,
} from '../../../ai/tools/side-effect-delivery.port';
import type { ExternalEffectOutcome } from '../../../core/external-effect';
import {
  NOTIFICATION_DELIVERY,
  type NotificationDelivery,
} from '../../../infrastructure/mail/notification-delivery.port';

@Injectable()
export class NotificationSideEffectDeliveryAdapter implements SideEffectDeliveryPort {
  constructor(
    @Inject(NOTIFICATION_DELIVERY)
    private readonly mailDelivery: NotificationDelivery,
  ) {}

  async deliver(
    command: SideEffectDeliveryCommand,
    idempotencyKey: string,
  ): Promise<ExternalEffectOutcome> {
    if (command.tool === 'notification.send@1') {
      return this.mailDelivery.deliver({
        to: command.payload.to,
        subject: command.payload.subject,
        text: command.payload.text,
        html: command.payload.html,
        idempotencyKey,
      });
    }

    return { kind: 'rejected' };
  }
}
