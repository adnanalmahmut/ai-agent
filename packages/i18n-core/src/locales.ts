export const SUPPORTED_LOCALES = ["ar", "en"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export type AppDirection = "rtl" | "ltr";

export const DEFAULT_LOCALE: AppLocale = "ar";

export type LocaleMeta = {
  code: AppLocale;
  name: string;
  nativeName: string;
  direction: AppDirection;
};

export const LOCALE_META = {
  ar: {
    code: "ar",
    name: "Arabic",
    nativeName: "العربية",
    direction: "rtl",
  },
  en: {
    code: "en",
    name: "English",
    nativeName: "English",
    direction: "ltr",
  },
} satisfies Record<AppLocale, LocaleMeta>;

export function isAppLocale(value: unknown): value is AppLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

export function parseAppLocale(value: unknown): AppLocale | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isAppLocale(normalized) ? normalized : undefined;
}

export function resolveAppLocale(value: unknown): AppLocale {
  return parseAppLocale(value) ?? DEFAULT_LOCALE;
}

export function getDirection(locale: AppLocale): AppDirection {
  return LOCALE_META[locale].direction;
}
