import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { initI18n, setLocale, getLocale } from '../source/runtime.ts';
import { mountDevtools } from '../source/devtools.ts';

// Mock localStorage (Node 22 doesn't have it)
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, val: string) => storage.set(key, val),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
  writable: true,
  configurable: true,
});

// Minimal DOM mock
beforeEach(() => {
  storage.clear();
  // Node 22 has navigator.language = 'zh-CN', so we must seed localStorage
  // to ensure initI18n picks 'en' as the default.
  storage.set('i18n-locale', 'en');
  initI18n({ locales: { en: { 'ui.lobby': 'Lobby' }, zh: { 'ui.lobby': '大厅' } }, defaultLocale: 'en', mode: 'dev' });

  // Mock document
  const elements = new Map<string, HTMLElement>();
  const body = {
    appendChild: vi.fn((el: HTMLElement) => {
      if (el.id) elements.set(el.id, el);
    }),
  };

  Object.defineProperty(globalThis, 'document', {
    value: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => {
        const el = {
          id: '',
          textContent: '',
          title: '',
          style: {} as Record<string, string>,
          addEventListener: vi.fn(),
          tagName: tag.toUpperCase(),
        };
        return el as unknown as HTMLElement;
      },
      body,
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, 'location', {
    value: { reload: vi.fn() },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  // @ts-ignore
  delete globalThis.document;
});

describe('mountDevtools', () => {
  it('should create a button element', () => {
    mountDevtools();
    const body = (globalThis as any).document.body;
    expect(body.appendChild).toHaveBeenCalledOnce();
    const btn = body.appendChild.mock.calls[0][0];
    expect(btn.id).toBe('__i18n_devtools__');
    expect(btn.textContent).toBe('EN');
  });

  it('should not create duplicate button', () => {
    mountDevtools();
    mountDevtools();
    const body = (globalThis as any).document.body;
    expect(body.appendChild).toHaveBeenCalledOnce();
  });

  it('should not mount when only one locale available', () => {
    initI18n({ locales: { en: { 'ui.lobby': 'Lobby' } }, defaultLocale: 'en', mode: 'dev' });
    mountDevtools();
    const body = (globalThis as any).document.body;
    expect(body.appendChild).not.toHaveBeenCalled();
  });

  it('should show "中" for zh locale', () => {
    setLocale('zh');
    initI18n({ locales: { en: { 'ui.lobby': 'Lobby' }, zh: { 'ui.lobby': '大厅' } }, defaultLocale: 'zh', mode: 'dev' });
    mountDevtools();
    const body = (globalThis as any).document.body;
    const btn = body.appendChild.mock.calls[0][0];
    expect(btn.textContent).toBe('中');
  });

  it('should not mount in locked mode', () => {
    initI18n({ locales: { en: { 'ui.lobby': 'Lobby' }, zh: { 'ui.lobby': '大厅' } }, defaultLocale: 'en', mode: 'locked', locale: 'zh' });
    mountDevtools();
    const body = (globalThis as any).document.body;
    expect(body.appendChild).not.toHaveBeenCalled();
  });
});
