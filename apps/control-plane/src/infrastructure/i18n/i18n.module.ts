import { Global, Module } from '@nestjs/common';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '@repo/i18n-core';
import { I18nModule } from 'nestjs-i18n';
import path from 'node:path';

import { AppI18nService } from './app-i18n.service';
import { AppLocaleResolver } from './app-locale.resolver';
import { currentModuleDir, resolveTranslationsPath } from './translations-path';

@Global()
@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: DEFAULT_LOCALE,
      // Run after guards so authenticated language preferences are available.
      disableMiddleware: true,
      fallbacks: Object.fromEntries(
        SUPPORTED_LOCALES.map((locale) => [`${locale}-*`, locale]),
      ),
      loaderOptions: {
        // Resolve copied assets in both source and compiled layouts.
        path: resolveTranslationsPath(currentModuleDir()),
        // Test watchers would keep the runner open.
        watch: process.env.NODE_ENV === 'development',
      },
      // Only development writes generated types back into the source tree.
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
