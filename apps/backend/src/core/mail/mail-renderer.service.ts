import { Injectable } from '@nestjs/common';
import { LOCALE_META } from '@repo/i18n-core';

import type { I18nPath } from '../../generated/i18n.generated';
import { AppI18nService } from '../i18n';
import type { MailJob, MailTemplate, RenderedMail } from './mail.types';

type TemplateKeys = {
  subject: I18nPath;
  heading: I18nPath;
  body: I18nPath;
  action: I18nPath;
  ignore: I18nPath;
};

const TEMPLATE_KEYS = {
  PASSWORD_RESET: {
    subject: 'mail.passwordReset.subject',
    heading: 'mail.passwordReset.heading',
    body: 'mail.passwordReset.body',
    action: 'mail.passwordReset.action',
    ignore: 'mail.passwordReset.ignore',
  },
  EMAIL_VERIFICATION: {
    subject: 'mail.emailVerification.subject',
    heading: 'mail.emailVerification.heading',
    body: 'mail.emailVerification.body',
    action: 'mail.emailVerification.action',
    ignore: 'mail.emailVerification.ignore',
  },
  ORGANIZATION_INVITATION: {
    subject: 'mail.organizationInvitation.subject',
    heading: 'mail.organizationInvitation.heading',
    body: 'mail.organizationInvitation.body',
    action: 'mail.organizationInvitation.action',
    ignore: 'mail.organizationInvitation.ignore',
  },
} as const satisfies Record<MailTemplate, TemplateKeys>;

/**
 * Renders a queued mail job into a localized document.
 *
 * Every lookup goes through `translateFor(job.locale, …)`. This service must
 * never call `I18nContext.current()` or read a request header: by the time a
 * worker runs it, the originating request is long gone, and reaching for
 * ambient context is how a retry ends up sending a different language than
 * the original attempt.
 */
@Injectable()
export class MailRendererService {
  constructor(private readonly i18n: AppI18nService) {}

  render(job: MailJob): RenderedMail {
    const { locale } = job;
    const { direction } = LOCALE_META[locale];
    const keys = TEMPLATE_KEYS[job.template];

    const variables = job.variables as Record<string, unknown>;

    const subject = this.i18n.translateFor(locale, keys.subject);
    const heading = this.i18n.translateFor(locale, keys.heading);
    const body = this.i18n.translateFor(locale, keys.body, variables);
    const action = this.i18n.translateFor(locale, keys.action);
    const ignore = this.i18n.translateFor(locale, keys.ignore);

    const linkFallback = this.i18n.translateFor(locale, 'common.linkFallback');
    const automated = this.i18n.translateFor(locale, 'common.automatedMessage');

    const actionUrl =
      typeof variables.actionUrl === 'string' ? variables.actionUrl : '';

    return {
      subject,
      locale,
      direction,
      // `lang` and `dir` on the document itself — mail clients do not inherit
      // direction from CSS text-align, and several ignore stylesheets
      // entirely. Alignment is a consequence of direction here, not a
      // substitute for it.
      html: `<!doctype html>
<html lang="${locale}" dir="${direction}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;">
      <tr>
        <td style="padding:32px;">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:#111827;">${escapeHtml(heading)}</h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#374151;">${escapeHtml(body)}</p>
          <p style="margin:0 0 24px;">
            <a href="${escapeAttribute(actionUrl)}" style="display:inline-block;padding:12px 24px;border-radius:8px;background:#2563eb;color:#ffffff;font-size:15px;text-decoration:none;">${escapeHtml(action)}</a>
          </p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#6b7280;">${escapeHtml(linkFallback)}</p>
          <!-- The URL is isolated so the bidi algorithm cannot reorder its
               punctuation when it sits inside a right-to-left paragraph. -->
          <p style="margin:0 0 24px;font-size:13px;word-break:break-all;color:#6b7280;"><bdi dir="ltr">${escapeHtml(actionUrl)}</bdi></p>
          <p style="margin:0 0 8px;font-size:13px;line-height:1.7;color:#6b7280;">${escapeHtml(ignore)}</p>
          <p style="margin:0;font-size:12px;color:#9ca3af;">${escapeHtml(automated)}</p>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
