// ---------------------------------------------------------------------------
// @minigame/i18n — Public API
// ---------------------------------------------------------------------------

// Types
export type { I18nOptions, I18nMode, I18nVars, LocaleMessages, LocaleMap } from './types.ts';

// Core runtime
export { initI18n, t, tData, getLocale, setLocale, getAvailableLocales, isInitialized, getMode } from './runtime.ts';

// Devtools (import guarded by `import.meta.env.DEV` in consumer code)
export { mountDevtools } from './devtools.ts';
