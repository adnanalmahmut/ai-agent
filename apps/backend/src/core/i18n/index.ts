export { AppI18nModule } from './i18n.module';
export { AppI18nService } from './app-i18n.service';
export type { TranslateArgs } from './app-i18n.service';
export {
  AppLocaleResolver,
  APP_LOCALE_COOKIE,
  APP_LOCALE_HEADER,
} from './app-locale.resolver';
export {
  ERROR_STATUS_CODES,
  ERROR_TRANSLATION_KEYS,
  VALIDATION_TRANSLATION_KEYS,
  errorCodeForStatus,
} from './error-translation-map';
export { resolveOutboundLocale } from './outbound-locale';
export type { OutboundLocaleCandidates } from './outbound-locale';
export {
  localeFromAcceptLanguage,
  localeFromAppHeader,
  localeFromCookieHeader,
  nodeHeaderGetter,
  resolveLocaleFromHeaders,
  webHeaderGetter,
} from './request-locale';
export type { HeaderGetter } from './request-locale';
export { UnifiedExceptionFilter } from './unified-exception.filter';
