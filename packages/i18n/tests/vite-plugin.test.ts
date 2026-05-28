import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { i18nPlugin } from '../source/vite.ts';
import type { Plugin, ResolvedConfig, Logger } from 'vite';

const tmpDir = resolve(import.meta.dirname ?? __dirname, '__tmp_vite_test__');
const localeDir = resolve(tmpDir, 'i18n');

const enMessages = {
  'ui.lobby': 'Lobby',
  'ui.room': 'Room: {{code}}',
  'debug.rtt': 'RTT: {{ms}}ms',
  'tower.arrow.name': 'Arrow Tower',
};

beforeEach(() => {
  mkdirSync(localeDir, { recursive: true });
  writeFileSync(resolve(localeDir, 'en.json'), JSON.stringify(enMessages));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Reset env
  delete process.env.VITE_I18N_MODE;
  delete process.env.VITE_I18N_LOCALE;
});

function createPlugin(mode: string, locale: string): Plugin {
  process.env.VITE_I18N_MODE = mode;
  process.env.VITE_I18N_LOCALE = locale;
  return i18nPlugin({ localeDir: './i18n' });
}

function resolveConfig(plugin: Plugin) {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnOnce: vi.fn(),
    clearScreen: vi.fn(),
    hasErrorLogged: vi.fn(),
    hasWarned: false,
  };
  const config = { root: tmpDir, logger } as unknown as ResolvedConfig;
  if (typeof plugin.configResolved === 'function') {
    (plugin.configResolved as (config: ResolvedConfig) => void)(config);
  }
  return config;
}

function transform(plugin: Plugin, code: string, id = 'test.ts'): string | null {
  if (typeof plugin.transform === 'function') {
    const result = (plugin.transform as Function)(code, id);
    if (result === null || result === undefined) return null;
    return typeof result === 'string' ? result : result.code;
  }
  return null;
}

describe('i18nPlugin — dev mode (no-op)', () => {
  it('should be a no-op in dev mode', () => {
    const plugin = createPlugin('dev', '');
    expect(plugin.name).toBe('vite-plugin-i18n-static');
    expect(plugin.transform).toBeUndefined();
  });

  it('should be a no-op when mode is not set', () => {
    delete process.env.VITE_I18N_MODE;
    delete process.env.VITE_I18N_LOCALE;
    const plugin = i18nPlugin();
    expect(plugin.transform).toBeUndefined();
  });
});

describe('i18nPlugin — static mode', () => {
  let plugin: Plugin;

  beforeEach(() => {
    plugin = createPlugin('static', 'en');
    resolveConfig(plugin);
  });

  it('should replace simple t() calls', () => {
    const code = `import { t } from '@minigame/i18n';\nconst x = t('ui.lobby');`;
    const result = transform(plugin, code)!;
    expect(result).toContain('"Lobby"');
    expect(result).not.toContain("t('ui.lobby')");
  });

  it('should replace t() with vars using template literal', () => {
    const code = `import { t } from '@minigame/i18n';\nt('ui.room', { code: roomCode });`;
    const result = transform(plugin, code)!;
    expect(result).toContain('`Room: ${roomCode}`');
  });

  it('should replace tData() calls', () => {
    const code = `import { tData } from '@minigame/i18n';\ntData('tower', 'arrow', 'name');`;
    const result = transform(plugin, code)!;
    expect(result).toContain('"Arrow Tower"');
  });

  it('should remove i18n imports', () => {
    const code = `import { t, initI18n } from '@minigame/i18n';\nconst x = t('ui.lobby');`;
    const result = transform(plugin, code)!;
    expect(result).not.toContain("from '@minigame/i18n'");
  });

  it('should remove initI18n() calls', () => {
    const code = `import { initI18n } from '@minigame/i18n';\ninitI18n({ locales: { en }, defaultLocale: 'en' });`;
    const result = transform(plugin, code)!;
    expect(result).not.toContain('initI18n');
  });

  it('should not transform non-ts files', () => {
    const code = `t('ui.lobby')`;
    const result = transform(plugin, code, 'style.css');
    expect(result).toBeNull();
  });

  it('should not transform files without i18n import', () => {
    const code = `const x = 'hello';`;
    const result = transform(plugin, code);
    expect(result).toBeNull();
  });

  it('should keep unknown keys unchanged', () => {
    const code = `import { t } from '@minigame/i18n';\nt('ui.unknown');`;
    const result = transform(plugin, code)!;
    expect(result).toContain("t('ui.unknown')");
  });

  it('should handle numeric interpolation', () => {
    const code = `import { t } from '@minigame/i18n';\nt('debug.rtt', { ms: latency });`;
    const result = transform(plugin, code)!;
    expect(result).toContain('`RTT: ${latency}ms`');
  });
});
