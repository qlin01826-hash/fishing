/// <reference types="vite/client" />
import type { I18nMode } from '@minigame/i18n'
import { initI18n, mountDevtools, t } from '@minigame/i18n'
import { initPixiAppWithHighDpi } from '@minigame/render-adapter/pixi'
import * as PIXI from 'pixi.js'
import { Application } from 'pixi.js'
import enLocale from '../../i18n/en.json'
import zhLocale from '../../i18n/zh.json'
import { Engine } from './source/engine/Engine'
import { FishingScene } from './source/fishing/FishingScene'

// Initialize i18n
const i18nMode = (import.meta.env.VITE_I18N_MODE as I18nMode | undefined) ?? 'locked'
const i18nLocale = import.meta.env.VITE_I18N_LOCALE as string | undefined

initI18n({
  locales: { zh: zhLocale, en: enLocale },
  defaultLocale: 'en',
  fallbackLocale: 'en',
  mode: i18nMode,
  locale: i18nLocale,
})

if (import.meta.env.DEV) {
  mountDevtools()
}

;(window as any).PIXI = PIXI

let app: Application | null = null
let engine: Engine | null = null
let scene: FishingScene | null = null
let highDpiCleanup: (() => void) | null = null

async function startGame() {
  if (app) return

  const container = document.getElementById('game-container')
  if (!container) {
    throw new Error('Missing #game-container')
  }

  app = new Application()
  highDpiCleanup = await initPixiAppWithHighDpi({
    app,
    container,
    appOptions: {
      backgroundColor: 0x051628,
      antialias: true,
    },
    onResize: ({ width, height }) => {
      scene?.onResize(width, height)
    },
  })

  container.appendChild(app.canvas)

  engine = new Engine(app)
  scene = new FishingScene(engine)
  engine.setScene(scene)

  ;(window as any).game = engine

  const loadingScreen = document.getElementById('loading-screen')
  if (loadingScreen) {
    loadingScreen.classList.add('hidden')
  }

  app.canvas.tabIndex = 0
  app.canvas.focus()
  app.canvas.addEventListener('pointerdown', () => {
    app?.canvas.focus()
  })

  engine.start()
}

function destroyGame() {
  highDpiCleanup?.()
  highDpiCleanup = null
  engine?.destroy()
  engine = null
  scene = null

  if (app) {
    app.canvas.remove()
    app.destroy(true)
    app = null
  }
}

window.addEventListener('beforeunload', () => {
  destroyGame()
})

/**
 * Push a human-readable failure onto the loading screen so we get
 * useful diagnostics even when DevTools isn't open (which is the
 * common case on mobile and when the user just double-clicks the
 * standalone build).
 */
function showFatalError(prefix: string, err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  console.error(prefix, err)
  const screen = document.getElementById('loading-screen')
  if (!screen) return
  screen.classList.remove('hidden')
  screen.innerHTML = `
    <div style="max-width: 90%; padding: 20px; color: #ffd166; font-family: monospace; font-size: 12px; text-align: left; overflow: auto; max-height: 80vh;">
      <div style="font-size: 16px; margin-bottom: 12px; color: #ff8080;">⚠ ${prefix}</div>
      <pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(message)}</pre>
    </div>
  `
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Heartbeat flag so the fail-safe in index.html knows the JS bundle
// successfully reached main.ts (vs. silently failing to load the module,
// which is what happens when index.html is opened via file:// without
// a server).
;(window as any).__GAME_BOOT__ = true

window.addEventListener('error', (e) => {
  showFatalError('Uncaught error', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  showFatalError('Unhandled promise rejection', e.reason)
})

void startGame().catch((error) => {
  showFatalError('Game failed to start', error)
})
