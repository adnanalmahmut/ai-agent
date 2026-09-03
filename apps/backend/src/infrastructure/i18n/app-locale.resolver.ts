import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { I18nResolver } from 'nestjs-i18n';

import { nodeHeaderGetter, resolveLocaleFromHeaders } from './request-locale';

export { APP_LOCALE_COOKIE, APP_LOCALE_HEADER } from './request-locale';

type RequestWithMaybeUser = Request & {
  user?: { preferredLanguage?: unknown } | null;
};

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
