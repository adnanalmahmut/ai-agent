import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { mailConfig } from '../config';
import { LogNotificationDelivery } from './log-notification.delivery';
import { formatSender } from './mail-transport';
import { ResendNotificationDelivery } from './resend-notification.delivery';

/**
 * Injection token for the governed side-effect delivery port.
 *
 * Separate from `MAIL_TRANSPORT` on purpose. That port was designed for auth
 * mail, where a duplicate verification message is tolerable and the caller is
 * fire-and-forget; this one carries a provider idempotency key and answers
 * with a closed outcome the worker can act on. Sharing the interface would
 * mean either widening auth mail with a key it does not need or leaving the
 * governed effect without one.
 */
export const NOTIFICATION_DELIVERY = Symbol('NOTIFICATION_DELIVERY');

/** The message as it will leave, already rendered and addressed. */
export type NotificationMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /**
   * The stable identity of this effect, derived from durable application
   * state. The same value on every retry of the same approved action — never
   * generated here, never generated per attempt.
   */
  idempotencyKey: string;
};

/**
 * Everything the worker is allowed to learn from a delivery attempt.
 *
 * Three answers. `accepted` carries the provider's own identifier for the
 * message, which is the durable fact success is reconstructed from.
 * `rejected` means the provider refused deterministically and sent nothing:
 * retrying the same payload cannot change it. `unavailable` covers everything
 * else — a network failure, a timeout, a 5xx, a rate limit, a concurrent
 * duplicate in flight — and its defining property is that the provider *may*
 * have accepted the request. The caller must not read it as "not sent".
 *
 * Deliberately not an `Error`. The SDK's error carries the request it
 * rejected, which at this point is the recipient and the message; an adapter
 * that threw would put that one `catch` away from a log line. Nothing about
 * the provider's response but its classification crosses this boundary.
 */
export type ExternalEffectOutcome =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

export interface NotificationDelivery {
  /**
   * Whether this adapter can honour the retry contract.
   *
   * `false` means the configured provider offers no idempotency guarantee, so
   * a retried delivery could send twice. The tool reads this in
   * `prepareEffect`, before any lookup and before any attempt is recorded, and
   * refuses with `delivery_unsupported` — a side effect this application
   * cannot make safe is one it does not perform.
   */
  readonly idempotent: boolean;
  /**
   * The sender exactly as it will appear on the wire.
   *
   * Part of the payload the provider deduplicates on, so part of what the
   * tool digests: a sender changed between two attempts is a changed payload,
   * and the digest has to say so before the provider does.
   */
  readonly sender: string;
  deliver(message: NotificationMessage): Promise<ExternalEffectOutcome>;
}

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
