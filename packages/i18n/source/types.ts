/** Locale value: either a string leaf or a nested object */
export type LocaleValue = string | { [key: string]: LocaleValue };

/** Locale dictionary: nested key-value map */
export type LocaleMessages = Record<string, LocaleValue>;

/** All loaded locales keyed by locale code */
export type LocaleMap = Record<string, LocaleMessages>;

/** i18n runtime mode */
export type I18nMode = 'dev' | 'locked' | 'static';

/** Options for initI18n() */
export interface I18nOptions {
  /** Map of locale code → messages, e.g. { zh: {...}, en: {...} } */
  locales: LocaleMap;
  /** Default locale code used when no preference is found */
  defaultLocale: string;
  /** Fallback locale when a key is missing in the active locale */
  fallbackLocale?: string;
  /**
   * Runtime mode:
   * - `'dev'` (default): full locale switching + devtools
   * - `'locked'`: force a single locale, disable switching and devtools
   * - `'static'`: compile-time replacement (handled by Vite plugin)
   */
  mode?: I18nMode;
  /** Force this locale (used with `mode: 'locked'`). Overrides localStorage/navigator detection. */
  locale?: string;
}

/** Variables passed to t() for interpolation */
export type I18nVars = Record<string, string | number>;
