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

@Injectable()
export class AppI18nService {
  constructor(private readonly i18n: I18nService<I18nTranslations>) {}

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

  translateFor(locale: AppLocale, key: I18nPath, args?: TranslateArgs): string {
    return this.i18n.translate(key, { lang: locale, args });
  }

  get fallbackLocale(): AppLocale {
    return DEFAULT_LOCALE;
  }
}
