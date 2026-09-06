import type { AppLocale } from '@repo/i18n-core';

export const MAIL_TEMPLATES = [
  'PASSWORD_RESET',
  'EMAIL_VERIFICATION',
  'ORGANIZATION_INVITATION',
] as const;

export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

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
  locale: AppLocale;
  direction: 'rtl' | 'ltr';
};

export type OutboundMail = {
  to: string;
  from: { address: string; name: string };
  subject: string;
  html: string;
  meta: {
    template: MailTemplate;
    locale: AppLocale;
    direction: 'rtl' | 'ltr';
  };
};

export type MailDeliveryResult = {
  provider: MailDriver;
  messageId?: string;
};
