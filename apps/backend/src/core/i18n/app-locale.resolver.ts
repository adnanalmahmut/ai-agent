import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { I18nResolver } from 'nestjs-i18n';

import { nodeHeaderGetter, resolveLocaleFromHeaders } from './request-locale';

export { APP_LOCALE_COOKIE, APP_LOCALE_HEADER } from './request-locale';

/**
 * A request carrying whatever the authentication layer attached to it.
 *
 * Typed loosely on purpose: `req.user` is only populated after an auth guard
 * has run, and this resolver executes for *every* request — including
 * unauthenticated ones and requests to routes with no guard at all.
 */
type RequestWithMaybeUser = Request & {
  user?: { preferredLanguage?: unknown } | null;
};

/**
 * Resolves the locale for a backend request, in one documented order:
 *
 *   1. `X-App-Locale` header      — explicit override by the caller
 *   2. authenticated user's saved preference
 *   3. `APP_LOCALE` cookie        — persisted web preference
 *   4. `Accept-Language` header   — browser preference
 *   5. (nothing) → `fallbackLanguage` configured on `I18nModule` (`ar`)
 *
 * The precedence itself lives in `request-locale.ts` as pure functions. This
 * class is only the Nest-facing adapter: the identical rule has to run against
 * a Web-Fetch `Request` inside Better Auth's email callbacks, and two copies
 * of a precedence rule is two rules that will eventually disagree.
 *
 * Written as a single resolver instead of a stack of built-in ones because the
 * precedence and the validation rule are part of the API contract — the
 * built-ins would happily resolve `klingon` and leave the chain.
 *
 * Note on ordering: this runs from `I18nLanguageInterceptor`, not from
 * `I18nMiddleware` (which `AppI18nModule` disables). That is what makes step 2
 * reachable at all — see the comment on `disableMiddleware` in `i18n.module.ts`.
 */
@Injectable()
export class AppLocaleResolver implements I18nResolver {
  resolve(context: ExecutionContext): string | undefined {
    if (context.getType() !== 'http') {
      // Non-HTTP execution contexts (queue workers, cron) have no ambient
      // request locale by design — see `resolveOutboundLocale`.
      return undefined;
    }

    const request = context.switchToHttp().getRequest<RequestWithMaybeUser>();

    return resolveLocaleFromHeaders(
      nodeHeaderGetter(request.headers),
      request.user?.preferredLanguage,
    );
  }
}
