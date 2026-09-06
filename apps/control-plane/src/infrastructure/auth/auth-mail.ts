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

// Kept beside the routes they mirror in the platform application; these are the
// only destinations security mail is allowed to return to.
const VERIFICATION_RETURN_PATH = '/verify-email?status=verified';
const PASSWORD_RESET_RETURN_PATH = '/reset-password';

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
      const locale = resolveRecipientLocale(user, request);

      mail.dispatch({
        template: 'EMAIL_VERIFICATION',
        locale,
        to: user.email,
        variables: {
          name: displayName(user),
          actionUrl: withServerDecidedReturn(
            url,
            returnUrl(options.platformUrl, locale, VERIFICATION_RETURN_PATH),
          ),
        },
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
      const locale = resolveRecipientLocale(user, request);

      mail.dispatch({
        template: 'PASSWORD_RESET',
        locale,
        to: user.email,
        variables: {
          name: displayName(user),
          actionUrl: withServerDecidedReturn(
            url,
            returnUrl(options.platformUrl, locale, PASSWORD_RESET_RETURN_PATH),
          ),
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

function returnUrl(
  platformUrl: string,
  locale: AppLocale,
  path: string,
): string {
  return `${platformUrl}/${locale}${path}`;
}

// Security mail must return the recipient to a destination this server chose.
// Better Auth builds the mailed link around the caller's `callbackURL` /
// `redirectTo`, and both endpoints are unauthenticated, so otherwise any caller
// decides where the recipient lands. For password reset that destination
// receives the reset token as a query parameter, which makes an arbitrary
// destination an account-takeover path rather than only an open redirect.
// Overwriting the parameter keeps Better Auth's own route and token untouched
// and replaces nothing but the return address.
function withServerDecidedReturn(url: string, destination: string): string {
  const link = new URL(url);
  link.searchParams.set('callbackURL', destination);
  return link.toString();
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
