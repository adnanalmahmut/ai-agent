import { Injectable } from '@nestjs/common';
import {
  DEFAULT_LOCALE,
  resolveAppLocale,
  type AppLocale,
} from '@repo/i18n-core';
import { I18nContext, I18nService } from 'nestjs-i18n';

import type {
  I18nPath,
  I18nTranslations,
} from '../../generated/i18n.generated';

export type TranslateArgs = Record<string, unknown>;

/**
 * Thin, typed facade over `I18nService`.
 *
 * Two things it buys over using `I18nService` directly:
 *
 * 1. keys are checked against the generated `I18nTranslations`, so a typo
 *    like `validation.INVALID_EMIAL` fails the build instead of silently
 *    shipping a raw key to a user;
 * 2. the locale is always a validated `AppLocale`, never an arbitrary string
 *    that happened to arrive on a header.
 */
@Injectable()
export class AppI18nService {
  constructor(private readonly i18n: I18nService<I18nTranslations>) {}

  /**
   * The locale resolved for the request currently being handled.
   *
   * Returns the default locale outside of a request context (queue worker,
   * scheduled job). Code running there must pass an explicit locale instead
   * of relying on this — see `resolveOutboundLocale`.
   */
  get currentLocale(): AppLocale {
    return resolveAppLocale(I18nContext.current()?.lang);
  }

  translate(
    key: I18nPath,
    options?: { locale?: AppLocale; args?: TranslateArgs },
  ): string {
    return this.i18n.translate(key, {
      lang: options?.locale ?? this.currentLocale,
      args: options?.args,
      defaultValue: undefined,
    });
  }

  /**
   * Translates for an explicitly chosen locale, ignoring any ambient request
   * context. This is the only form that is safe inside asynchronous workers.
   */
  translateFor(locale: AppLocale, key: I18nPath, args?: TranslateArgs): string {
    return this.i18n.translate(key, { lang: locale, args });
  }

  get fallbackLocale(): AppLocale {
    return DEFAULT_LOCALE;
  }
}
