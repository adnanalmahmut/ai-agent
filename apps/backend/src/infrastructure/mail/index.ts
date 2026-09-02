/**
 * Public surface of the mail module.
 *
 * `MAIL_TRANSPORT`, the `MailTransport` interface, `OutboundMail` and every
 * transport class are absent on purpose. Consumers describe *what* to send —
 * a `MailJob` — and `MailService` decides how. Exporting the transport would
 * hand callers a way around rendering and locale resolution.
 */
export { MailModule } from './mail.module';
export { MailService } from './mail.service';
export { MailRendererService } from './mail-renderer.service';
export { MailDeliveryError } from './mail-transport';
export {
  NOTIFICATION_DELIVERY,
  NotificationDeliveryModule,
} from './notification-delivery';
export type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery';
export { MAIL_DRIVERS, MAIL_TEMPLATES } from './mail.types';
export type {
  MailDeliveryResult,
  MailDriver,
  MailJob,
  MailTemplate,
  RenderedMail,
} from './mail.types';
