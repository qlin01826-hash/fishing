import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';
import type { LocaleMessages, LocaleValue } from './types.ts';

export interface I18nPluginOptions {
  /** Directory containing locale JSON files, relative to project root */
  localeDir?: string;
}

/**
 * Vite plugin for @minigame/i18n static mode.
 *
 * When `VITE_I18N_MODE=static` and `VITE_I18N_LOCALE` is set, this plugin
 * replaces `t('key')` and `tData('ns','id','field')` calls with string
 * literals at compile time, then strips all i18n imports and `initI18n()`
 * calls. The result is zero i18n runtime in the production bundle.
 *
 * In `dev` or `locked` mode the plugin is a no-op.
 */
export function i18nPlugin(options: I18nPluginOptions = {}): Plugin {
  const mode = process.env.VITE_I18N_MODE ?? 'dev';
  const locale = process.env.VITE_I18N_LOCALE ?? '';

  // Only operate in static mode
  if (mode !== 'static' || !locale) {
    return { name: 'vite-plugin-i18n-static' };
  }

  let messages: Record<string, string> = {};

  return {
    name: 'vite-plugin-i18n-static',
    enforce: 'pre',

    configResolved(config) {
      const dir = options.localeDir ?? './i18n';
      const filePath = resolve(config.root, dir, `${locale}.json`);
      if (!existsSync(filePath)) {
        config.logger.warn(`[i18n] Locale file not found: ${filePath}`);
        return;
      }
      messages = flatten(JSON.parse(readFileSync(filePath, 'utf-8')) as LocaleMessages);
      config.logger.info(`[i18n] Static mode: loaded ${Object.keys(messages).length} keys for "${locale}"`);
    },

    transform(code, id) {
      // Only process TS/JS files that use i18n
      if (!/\.[jt]sx?$/.test(id)) return null;
      if (!code.includes('@minigame/i18n')) return null;

      let result = code;

      // Replace t('key') and t('key', { ... }) calls
      // Handles: t('ui.lobby') → "Lobby"
      //          t('ui.room', { code: roomCode }) → `Room: ${roomCode}`
      result = result.replace(
        /\bt\(\s*'([^']+)'\s*(?:,\s*(\{[^}]*\}))?\s*\)/g,
        (match, key: string, varsExpr?: string) => {
          const msg = messages[key];
          if (msg === undefined) return match; // keep original if key not found

          if (!varsExpr) {
            return JSON.stringify(msg);
          }

          // Parse variable names from the vars object expression
          // e.g. { code: roomCode, count: n } → extract var mappings
          if (!msg.includes('{{')) {
            return JSON.stringify(msg);
          }

          // Build template literal: replace {{var}} with ${expr}
          const varMap = parseVarExpr(varsExpr);
          const template = msg.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
            const expr = varMap[name];
            return expr ? `\${${expr}}` : `{{${name}}}`;
          });

          return '`' + template + '`';
        },
      );

      // Replace tData('ns', 'id', 'field') calls
      result = result.replace(
        /\btData\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g,
        (match, ns: string, id: string, field: string) => {
          const key = `${ns}.${id}.${field}`;
          const msg = messages[key];
          return msg !== undefined ? JSON.stringify(msg) : match;
        },
      );

      // Remove import statements for @minigame/i18n
      result = result.replace(
        /import\s+\{[^}]*\}\s+from\s+['"]@minigame\/i18n['"]\s*;?\n?/g,
        '',
      );

      // Remove initI18n(...) call statements
      result = result.replace(
        /initI18n\s*\([^)]*\)\s*;?\n?/g,
        '',
      );

      if (result === code) return null;
      return { code: result, map: null };
    },
  };
}

/**
 * Parse a simple object expression like `{ code: roomCode, ms: latency }`
 * into a map { code: 'roomCode', ms: 'latency' }.
 */
function parseVarExpr(expr: string): Record<string, string> {
  const map: Record<string, string> = {};
  // Remove outer braces and whitespace
  const inner = expr.replace(/^\{|\}$/g, '').trim();
  // Match key: value pairs
  const pairRe = /(\w+)\s*:\s*([^,}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(inner)) !== null) {
    map[m[1]] = m[2].trim();
  }
  return map;
}

/** Flatten a nested locale object to dot-separated keys. */
function flatten(obj: LocaleMessages, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      result[fullKey] = value;
    } else {
      Object.assign(result, flatten(value as LocaleMessages, fullKey));
    }
  }
  return result;
}
