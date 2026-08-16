import type { AppLocale } from '@repo/i18n-core';

export const MAIL_TEMPLATES = [
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'ORGANIZATION_INVITATION',
] as const;

export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

/**
 * Delivery drivers that actually exist.
 *
 * Deliberately not a wish list. `MAIL_DRIVER` is validated against this, so
 * naming a provider here before its transport is written would turn a boot
 * failure into a runtime one.
 */
export const MAIL_DRIVERS = ['log', 'resend', 'ses', 'smtp'] as const;

export type MailDriver = (typeof MAIL_DRIVERS)[number];

type TemplateVariables = {
  PASSWORD_RESET: {
    name: string;
    actionUrl: string;
    expiresInMinutes: number;
  };
  EMAIL_VERIFICATION: {
    name: string;
    actionUrl: string;
  };
  ORGANIZATION_INVITATION: {
    inviterName: string;
    organizationName: string;
    actionUrl: string;
    expiresInHours: number;
  };
};

/**
 * What gets put on the queue.
 *
 * `locale` is a required, already-validated field — not something the worker
 * derives. This is the whole point of the contract: the language is decided
 * while the request context still exists, then travels *with* the job, so a
 * retry three hours later renders exactly the same language as the first
 * attempt.
 */
export type MailJob<T extends MailTemplate = MailTemplate> = {
  [K in T]: {
    template: K;
    locale: AppLocale;
    to: string;
    variables: TemplateVariables[K];
  };
}[T];

export type RenderedMail = {
  subject: string;
  html: string;
  /** Mirrors the `<html>` attributes, handy for provider-level metadata. */
  locale: AppLocale;
  direction: 'rtl' | 'ltr';
};

/**
 * A rendered, addressed message — what a transport actually puts on the wire.
 *
 * The split from `MailJob` matters: a job says *what* to send and in which
 * language, this says *what was produced*. A transport receives only the
 * latter, which is why no transport can accidentally re-render, re-translate,
 * or reach for a template.
 */
export type OutboundMail = {
  to: string;
  from: { address: string; name: string };
  subject: string;
  html: string;
  /**
   * Diagnostics only. Real providers ignore this; `LogMailTransport` reports
   * it. Kept out of the fields above so nothing here can be mistaken for part
   * of the envelope.
   */
  meta: {
    template: MailTemplate;
    locale: AppLocale;
    direction: 'rtl' | 'ltr';
  };
};

export type MailDeliveryResult = {
  provider: MailDriver;
  /** Provider-assigned id where there is one; the `log` driver has none. */
  messageId?: string;
};
