import type { AppLocale } from '@repo/i18n-core';

import {
  localeFromAcceptLanguage,
  localeFromAppHeader,
  localeFromCookieHeader,
  resolveOutboundLocale,
  webHeaderGetter,
} from '../i18n';
import type { MailService } from '../mail';

/**
 * The shape Better Auth passes to its email callbacks.
 *
 * Described structurally rather than imported from `better-auth`: these are
 * the fields this adapter reads, and naming them here means a change in the
 * library's internal typing shows up as a compile error at the boundary
 * instead of rippling through the mail layer.
 */
type AuthMailUser = {
  email: string;
  name?: string | null;
  preferredLanguage?: unknown;
};

/** The Web-Fetch `Request` Better Auth forwards; absent for server-side calls. */
type AuthMailRequest = { headers: { get(name: string): string | null } };

type AuthMailPayload = { user: AuthMailUser; url: string; token: string };

type InvitationPayload = {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: AuthMailUser };
};

/**
 * Looks up an invitee's saved language by email.
 *
 * Injected rather than reached for, so this file keeps its single dependency
 * and stays testable without a database. Returns `null` when the address does
 * not belong to an account — which is the common case for an invitation.
 */
export type PreferredLanguageLookup = (email: string) => Promise<unknown>;

export type AuthMailOptions = {
  resetPasswordExpiresInMinutes: number;
  invitationExpiresInHours: number;
  /**
   * Public base URL of the Platform, mount point included. Better Auth does
   * not build invitation URLs, so this application does.
   */
  platformUrl: string;
  lookupPreferredLanguage: PreferredLanguageLookup;
};

/**
 * Translates Better Auth's email callbacks into typed mail jobs.
 *
 * A plain function, not a Nest provider: it has no lifecycle, and
 * `AuthModule.forRootAsync` can already inject `MailService` from
 * `MailModule`. Making it a provider would add a registration whose only
 * purpose is to appear on an architecture diagram.
 *
 * Its whole responsibility is: decide the language, build a `MailJob`, hand it
 * to `MailService`. It does not render, does not know a provider exists, and
 * never touches `I18nContext` — Better Auth mounts outside the Nest pipeline,
 * so there is no ambient request context here to read even if it were allowed.
 */
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

    /**
     * Organization invitation.
     *
     * Better Auth deliberately generates no URL for this one, so the accept
     * link is built here from configured origin plus invitation id.
     */
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

/**
 * Where the invitation email points.
 *
 * The locale is in the path because the Platform's router requires it: it
 * matches on a real `:locale` segment, and a link without one is redirected
 * to the default language. The one already resolved for the *email* is
 * reused, so the page the invitee lands on is in the same language as the
 * message that brought them there.
 *
 * The id is encoded rather than interpolated raw — it is a database
 * identifier today, but the escaping is what keeps that an implementation
 * detail rather than an assumption.
 *
 * This path and its `id` parameter are a contract with
 * `apps/platform/src/features/auth/routes.ts`; neither side can rename them
 * alone.
 */
function invitationUrl(
  platformUrl: string,
  locale: AppLocale,
  invitationId: string,
): string {
  return `${platformUrl}/${locale}/organizations/accept-invitation?id=${encodeURIComponent(invitationId)}`;
}

/**
 * Applies the documented precedence when the recipient *is* the requester.
 *
 * The three slots are filled deliberately, not by lumping every header into
 * one bucket: `X-App-Locale` is an *explicit* choice and outranks the stored
 * preference, while the cookie and `Accept-Language` are passive hints that
 * rank below it. Feeding the header in as `requestLocale` would silently
 * invert that — a user with `preferredLanguage=en` asking for Arabic would be
 * emailed in English.
 *
 * Resolution happens here, while the request still exists, and the result
 * travels on the job. A retry hours later renders the same language.
 */
function resolveRecipientLocale(user: AuthMailUser, request?: AuthMailRequest) {
  const get = webHeaderGetter(request);

  return resolveOutboundLocale({
    requested: localeFromAppHeader(get),
    userPreferred: user.preferredLanguage,
    requestLocale: localeFromCookieHeader(get) ?? localeFromAcceptLanguage(get),
  });
}

/**
 * Applies the precedence when the recipient is a *third party*.
 *
 * `requested` is deliberately left empty. The only explicit signal on the
 * request is the **inviter's** `X-App-Locale`, and that is the inviter's own
 * interface language — letting it occupy the top slot would mean an
 * Arabic-speaking admin overrides the saved English preference of the person
 * actually receiving the mail. The inviter's passive hints still serve as the
 * fallback when the invitee has no account and therefore no preference, which
 * is usually the right guess.
 */
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

/** Better Auth requires a name at sign-up; the fallback is belt-and-braces. */
function displayName(user: AuthMailUser): string {
  return user.name?.trim() || user.email;
}
