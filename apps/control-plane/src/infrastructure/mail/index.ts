export { MailModule } from './mail.module';
export { MailService } from './mail.service';
export { MailRendererService } from './mail-renderer.service';
export { MailDeliveryError } from './mail-transport';
export { NotificationDeliveryModule } from './notification-delivery';
export { NOTIFICATION_DELIVERY } from './notification-delivery.port';
export type {
  ExternalEffectOutcome,
  NotificationDelivery,
  NotificationMessage,
} from './notification-delivery.port';
export { MAIL_DRIVERS, MAIL_TEMPLATES } from './mail.types';
export type {
  MailDeliveryResult,
  MailDriver,
  MailJob,
  MailTemplate,
  RenderedMail,
} from './mail.types';
