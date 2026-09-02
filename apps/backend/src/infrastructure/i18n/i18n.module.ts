import { Global, Module } from '@nestjs/common';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { I18nModule } from 'nestjs-i18n';
import path from 'node:path';

import { AppI18nService } from './app-i18n.service';
import { AppLocaleResolver } from './app-locale.resolver';
import { currentModuleDir, resolveTranslationsPath } from './translations-path';

/**
 * Backend i18n wiring — translation loading and locale resolution only.
 *
 * Deliberate choices:
 *
 * - `AppLocaleResolver` is the *only* resolver. It implements the full
 *   documented precedence (header → user preference → cookie →
 *   accept-language) with validation at every step, which the built-in
 *   resolvers cannot express: they would happily resolve `klingon` and leave
 *   the chain. No built-in resolver follows it, so the rule "no ambient
 *   locale outside an HTTP request" stays literally true and cannot drift.
 * - No `QueryResolver`. `?lang=` is not part of the public API contract.
 * - No `APP_PIPE` / `APP_FILTER` here — those belong to
 *   `HttpInfrastructureModule`, which owns the request pipeline.
 */
@Global()
@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: DEFAULT_LOCALE,
      // Resolution must happen *after* guards, not before.
      //
      // With the middleware enabled, `nestjs-i18n` resolves the language in
      // `I18nMiddleware` and stores `req.i18nLang`; `I18nLanguageInterceptor`
      // then sees that value and returns early. Nest runs middleware before
      // guards, so `req.user` — which Better Auth's `AuthGuard` attaches — does
      // not exist yet, and step 2 of the documented precedence (the user's
      // saved `preferredLanguage`) could never fire. Nothing would look broken:
      // the other four steps work, so the field would simply be inert.
      //
      // Disabling the middleware leaves `I18nLanguageInterceptor` (registered
      // unconditionally by this module as an `APP_INTERCEPTOR`) to do the
      // resolution, and interceptors run after guards.
      //
      // The cost: an exception thrown *by a guard* short-circuits before any
      // interceptor, so there is no `I18nContext` on that path.
      // `UnifiedExceptionFilter` handles it by falling back to the same pure
      // resolver used here.
      disableMiddleware: true,
      fallbacks: Object.fromEntries(
        SUPPORTED_LOCALES.map((locale) => [`${locale}-*`, locale]),
      ),
      loaderOptions: {
        // The JSON files are copied into the build output by the `assets`
        // entry in nest-cli.json; this locates them for whichever layout the
        // current build produced, and throws at boot if they are absent.
        path: resolveTranslationsPath(currentModuleDir()),
        // Hot-reload translations while developing only. Enabling it under
        // test would leave file watchers open and hang the runner.
        watch: process.env.NODE_ENV === 'development',
      },
      // Keeps `src/generated/i18n.generated.ts` in step with the JSON while
      // developing, so a mistyped key like `validation.INVALID_EMIAL` fails
      // to compile instead of reaching production as a raw key. Resolved from
      // the working directory because it writes into the *source* tree —
      // never enabled outside development, where there is no source tree and
      // rewriting files would be wrong. `pnpm i18n:types` does it on demand.
      ...(process.env.NODE_ENV !== 'development'
        ? {}
        : {
            typesOutputPath: path.join(
              process.cwd(),
              'src/generated/i18n.generated.ts',
            ),
          }),
      resolvers: [AppLocaleResolver],
    }),
  ],
  providers: [AppLocaleResolver, AppI18nService],
  exports: [AppI18nService],
})
export class AppI18nModule {}
