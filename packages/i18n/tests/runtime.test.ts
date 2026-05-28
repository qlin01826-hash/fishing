import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initI18n, t, tData, getLocale, setLocale, getAvailableLocales, isInitialized, getMode } from '../source/runtime.ts';

const en = {
  'ui.lobby': 'Lobby',
  'ui.room': 'Room: {{code}}',
  'ui.score': 'Score: {{score}} pts',
  'debug.rtt': 'RTT: {{ms}}ms',
  'tower.arrow.name': 'Arrow Tower',
};

const zh = {
  'ui.lobby': '大厅',
  'ui.room': '房间: {{code}}',
  'ui.score': '分数: {{score}} 分',
  'debug.rtt': '延迟: {{ms}}ms',
  'tower.arrow.name': '箭塔',
};

// Mock localStorage
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, val: string) => storage.set(key, val),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// Mock navigator.language
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  writable: true,
});

beforeEach(() => {
  storage.clear();
});

describe('initI18n', () => {
  it('should initialize with default locale', () => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en' });
    expect(isInitialized()).toBe(true);
    expect(getLocale()).toBe('en');
  });

  it('should pick locale from localStorage', () => {
    storage.set('i18n-locale', 'zh');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(getLocale()).toBe('zh');
  });

  it('should detect locale from navigator.language', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'zh-CN' },
      writable: true,
    });
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(getLocale()).toBe('zh');
    // Restore
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      writable: true,
    });
  });

  it('should fall back to defaultLocale for unknown navigator language', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'fr-FR' },
      writable: true,
    });
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(getLocale()).toBe('en');
    Object.defineProperty(globalThis, 'navigator', {
      value: { language: 'en-US' },
      writable: true,
    });
  });

  it('should ignore invalid localStorage value', () => {
    storage.set('i18n-locale', 'fr');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(getLocale()).toBe('en');
  });
});

describe('t()', () => {
  beforeEach(() => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en' });
  });

  it('should return translated string', () => {
    expect(t('ui.lobby')).toBe('Lobby');
  });

  it('should interpolate variables', () => {
    expect(t('ui.room', { code: 'ABC' })).toBe('Room: ABC');
  });

  it('should interpolate numeric variables', () => {
    expect(t('debug.rtt', { ms: 42 })).toBe('RTT: 42ms');
  });

  it('should interpolate multiple variables', () => {
    expect(t('ui.score', { score: 100 })).toBe('Score: 100 pts');
  });

  it('should keep unknown variable placeholders', () => {
    expect(t('ui.room', {})).toBe('Room: {{code}}');
  });

  it('should return key itself when key is missing', () => {
    expect(t('ui.nonexistent')).toBe('ui.nonexistent');
  });

  it('should fallback to fallbackLocale', () => {
    // Init with zh as current, en as fallback; remove a key from zh
    const zhPartial = { 'ui.lobby': '大厅' };
    initI18n({ locales: { en, zh: zhPartial }, defaultLocale: 'zh', fallbackLocale: 'en' });
    // ui.room exists only in en
    expect(t('ui.room', { code: 'X' })).toBe('Room: X');
  });

  it('should work with zh locale', () => {
    storage.set('i18n-locale', 'zh');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(t('ui.lobby')).toBe('大厅');
    expect(t('ui.room', { code: '123' })).toBe('房间: 123');
  });
});

describe('tData()', () => {
  beforeEach(() => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en' });
  });

  it('should compose key from namespace.id.field', () => {
    expect(tData('tower', 'arrow', 'name')).toBe('Arrow Tower');
  });

  it('should work with zh locale', () => {
    storage.set('i18n-locale', 'zh');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
    expect(tData('tower', 'arrow', 'name')).toBe('箭塔');
  });

  it('should return composed key when missing', () => {
    expect(tData('tower', 'cannon', 'name')).toBe('tower.cannon.name');
  });
});

describe('setLocale / getLocale', () => {
  beforeEach(() => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'dev' });
  });

  it('should update current locale', () => {
    setLocale('zh');
    expect(getLocale()).toBe('zh');
  });

  it('should persist to localStorage', () => {
    setLocale('zh');
    expect(storage.get('i18n-locale')).toBe('zh');
  });
});

describe('locked mode', () => {
  it('should force the specified locale', () => {
    storage.set('i18n-locale', 'en');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'locked', locale: 'zh' });
    expect(getLocale()).toBe('zh');
    expect(getMode()).toBe('locked');
  });

  it('should ignore localStorage in locked mode', () => {
    storage.set('i18n-locale', 'en');
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'locked', locale: 'zh' });
    expect(getLocale()).toBe('zh');
  });

  it('should make setLocale a no-op', () => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'locked', locale: 'zh' });
    setLocale('en');
    expect(getLocale()).toBe('zh');
    expect(storage.get('i18n-locale')).toBeUndefined();
  });

  it('should translate using the locked locale', () => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'locked', locale: 'zh' });
    expect(t('ui.lobby')).toBe('大厅');
  });

  it('should fall back to defaultLocale if locked locale not in locales', () => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en', mode: 'locked', locale: 'fr' });
    expect(getLocale()).toBe('en');
  });
});

describe('getAvailableLocales', () => {
  it('should return all locale codes', () => {
    initI18n({ locales: { en, zh }, defaultLocale: 'en' });
    expect(getAvailableLocales()).toEqual(['en', 'zh']);
  });
});
