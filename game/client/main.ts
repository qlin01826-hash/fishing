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

void startGame().catch((error) => {
  console.error(error)
})
