import type { I18nOptions, I18nMode, I18nVars, LocaleMessages, LocaleMap, LocaleValue } from './types.ts';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let locales: LocaleMap = {};
let currentLocale = '';
let fallbackLocale = '';
let currentMode: I18nMode = 'locked';
let initialized = false;

const STORAGE_KEY = 'i18n-locale';
const VAR_RE = /\{\{(\w+)\}\}/g;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the i18n runtime. Must be called once at application startup.
 */
export function initI18n(options: I18nOptions): void {
  locales = options.locales;
  fallbackLocale = options.fallbackLocale ?? options.defaultLocale;
  currentMode = options.mode ?? 'locked';

  // In locked mode, force the specified locale — no localStorage/navigator detection
  if (currentMode === 'locked' && options.locale && options.locale in locales) {
    currentLocale = options.locale;
    initialized = true;
    return;
  }

  // Determine active locale: localStorage → navigator.language → default
  const stored = typeof localStorage !== 'undefined'
    ? localStorage.getItem(STORAGE_KEY)
    : null;

  if (stored && stored in locales) {
    currentLocale = stored;
  } else if (typeof navigator !== 'undefined') {
    const prefix = navigator.language.split('-')[0];
    currentLocale = prefix in locales ? prefix : options.defaultLocale;
  } else {
    currentLocale = options.defaultLocale;
  }

  initialized = true;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * Translate a key, with optional variable interpolation.
 *
 * @example
 * t('ui.lobby')                        // → "Lobby"
 * t('ui.room', { code: 'ABC123' })     // → "Room: ABC123"
 */
export function t(key: string, vars?: I18nVars): string {
  const msg = resolve(key);
  if (!vars) return msg;
  return msg.replace(VAR_RE, (_, name: string) =>
    name in vars ? String(vars[name]) : `{{${name}}}`,
  );
}

/**
 * Shorthand for game-content translation.
 *
 * `tData('tower', 'arrow_lv1', 'name')` is equivalent to
 * `t('tower.arrow_lv1.name')`.
 */
export function tData(namespace: string, id: string, field: string): string {
  return t(`${namespace}.${id}.${field}`);
}

// ---------------------------------------------------------------------------
// Locale management
// ---------------------------------------------------------------------------

/** Return the active locale code. */
export function getLocale(): string {
  return currentLocale;
}

/**
 * Set the active locale and persist to localStorage.
 * No-op when mode is `'locked'`.
 * The caller is responsible for reloading the page afterward.
 */
export function setLocale(locale: string): void {
  if (currentMode === 'locked') return;
  currentLocale = locale;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, locale);
  }
}

/** Return the list of available locale codes. */
export function getAvailableLocales(): string[] {
  return Object.keys(locales);
}

/** Return whether initI18n() has been called. */
export function isInitialized(): boolean {
  return initialized;
}

/** Return the current i18n mode. */
export function getMode(): I18nMode {
  return currentMode;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolve(key: string): string {
  const primary: LocaleMessages | undefined = locales[currentLocale];
  const val = primary ? deepGet(primary, key) : undefined;
  if (typeof val === 'string') return val;

  if (fallbackLocale && fallbackLocale !== currentLocale) {
    const fb: LocaleMessages | undefined = locales[fallbackLocale];
    const fbVal = fb ? deepGet(fb, key) : undefined;
    if (typeof fbVal === 'string') return fbVal;
  }

  // Return the key itself as last resort (makes missing keys visible)
  return key;
}

/** Resolve a dot-separated key path in a nested locale object. */
function deepGet(obj: LocaleMessages, key: string): LocaleValue | undefined {
  // Fast path: flat key exists directly
  if (key in obj) return obj[key];

  // Walk dot-separated segments
  const parts = key.split('.');
  let current: LocaleValue = obj;
  for (const part of parts) {
    if (current == null || typeof current === 'string') return undefined;
    current = (current as Record<string, LocaleValue>)[part];
  }
  return current;
}
