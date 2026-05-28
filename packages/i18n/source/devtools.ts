import { getLocale, setLocale, getAvailableLocales, getMode } from './runtime.ts';

const BUTTON_ID = '__i18n_devtools__';

/**
 * Inject a floating language-switcher button into the DOM.
 * Only call this in dev mode (`import.meta.env.DEV`).
 * Automatically skipped when mode is `'locked'`.
 */
export function mountDevtools(): void {
  if (getMode() === 'locked') return;
  if (typeof document === 'undefined') return;
  if (document.getElementById(BUTTON_ID)) return;

  const locales = getAvailableLocales();
  if (locales.length < 2) return;

  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.textContent = localeLabel(getLocale());
  btn.title = 'Switch language / 切换语言';

  Object.assign(btn.style, {
    position: 'fixed',
    bottom: '12px',
    right: '12px',
    zIndex: '99999',
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.3)',
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
    backdropFilter: 'blur(4px)',
    lineHeight: '1',
    padding: '0',
    fontFamily: 'system-ui, sans-serif',
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener('click', () => {
    const current = getLocale();
    const idx = locales.indexOf(current);
    const next = locales[(idx + 1) % locales.length];
    setLocale(next);
    location.reload();
  });

  document.body.appendChild(btn);
}

function localeLabel(locale: string): string {
  const labels: Record<string, string> = { zh: '中', en: 'EN', ja: 'JP', ko: 'KR' };
  return labels[locale] ?? locale.toUpperCase().slice(0, 2);
}
