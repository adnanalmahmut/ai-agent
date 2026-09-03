import type { ExternalEffectOutcome } from '../../core/external-effect';

export const NOTIFICATION_DELIVERY = Symbol('NOTIFICATION_DELIVERY');

export type NotificationMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export type { ExternalEffectOutcome } from '../../core/external-effect';

export interface NotificationDelivery {
  readonly idempotent: boolean;
  readonly sender: string;
  deliver(message: NotificationMessage): Promise<ExternalEffectOutcome>;
}
