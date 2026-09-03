import type { AppLocale } from '@repo/i18n-core';

import {
  localeFromAcceptLanguage,
  localeFromAppHeader,
  localeFromCookieHeader,
  resolveOutboundLocale,
  webHeaderGetter,
} from '../i18n';
import type { MailService } from '../mail';

type AuthMailUser = {
  email: string;
  name?: string | null;
  preferredLanguage?: unknown;
};

type AuthMailRequest = { headers: { get(name: string): string | null } };

type AuthMailPayload = { user: AuthMailUser; url: string; token: string };

type InvitationPayload = {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: AuthMailUser };
};

export type PreferredLanguageLookup = (email: string) => Promise<unknown>;

export type AuthMailOptions = {
  resetPasswordExpiresInMinutes: number;
  invitationExpiresInHours: number;
  platformUrl: string;
  lookupPreferredLanguage: PreferredLanguageLookup;
};

export function createAuthMailCallbacks(
  mail: MailService,
  options: AuthMailOptions,
) {
  // Arrow properties rather than shorthand methods: these are handed to Better
  // Auth as detached callbacks, so they must never depend on `this`. Writing
  // them this way makes that structural instead of a convention.
  return {
    sendVerificationEmail: (
      { user, url }: AuthMailPayload,
      request?: AuthMailRequest,
    ): Promise<void> => {
      mail.dispatch({
        template: 'EMAIL_VERIFICATION',
        locale: resolveRecipientLocale(user, request),
        to: user.email,
        variables: { name: displayName(user), actionUrl: url },
      });

      // `dispatch` is synchronous and never throws, so this resolves
      // immediately. That is deliberate: Better Auth awaits this callback by
      // default, and awaiting a real network send here would make the response
      // time depend on whether the address exists.
      return Promise.resolve();
    },

    sendResetPassword: (
      { user, url }: AuthMailPayload,
      request?: AuthMailRequest,
    ): Promise<void> => {
      mail.dispatch({
        template: 'PASSWORD_RESET',
        locale: resolveRecipientLocale(user, request),
        to: user.email,
        variables: {
          name: displayName(user),
          actionUrl: url,
          // Derived from the same configuration value that sets the token's
          // real lifetime, so the sentence in the email cannot drift from the
          // expiry the server will actually enforce.
          expiresInMinutes: options.resetPasswordExpiresInMinutes,
        },
      });

      return Promise.resolve();
    },

    sendInvitationEmail: async (
      data: InvitationPayload,
      request?: AuthMailRequest,
    ): Promise<void> => {
      const locale = await resolveInviteeLocale(data.email, request, options);

      mail.dispatch({
        template: 'ORGANIZATION_INVITATION',
        locale,
        to: data.email,
        variables: {
          inviterName: displayName(data.inviter.user),
          organizationName: data.organization.name,
          actionUrl: invitationUrl(options.platformUrl, locale, data.id),
          expiresInHours: options.invitationExpiresInHours,
        },
      });
    },
  };
}

function invitationUrl(
  platformUrl: string,
  locale: AppLocale,
  invitationId: string,
): string {
  return `${platformUrl}/${locale}/organizations/accept-invitation?id=${encodeURIComponent(invitationId)}`;
}

function resolveRecipientLocale(user: AuthMailUser, request?: AuthMailRequest) {
  const get = webHeaderGetter(request);

  return resolveOutboundLocale({
    requested: localeFromAppHeader(get),
    userPreferred: user.preferredLanguage,
    requestLocale: localeFromCookieHeader(get) ?? localeFromAcceptLanguage(get),
  });
}

async function resolveInviteeLocale(
  email: string,
  request: AuthMailRequest | undefined,
  options: AuthMailOptions,
) {
  const get = webHeaderGetter(request);

  return resolveOutboundLocale({
    userPreferred: await options.lookupPreferredLanguage(email),
    requestLocale: localeFromCookieHeader(get) ?? localeFromAcceptLanguage(get),
  });
}

function displayName(user: AuthMailUser): string {
  return user.name?.trim() || user.email;
}
