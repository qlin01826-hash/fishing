import type { Application, ApplicationOptions } from 'pixi.js'
import { onDisplayChange } from '@minigame/platform'
import type { DisplayScaleOptions } from '@minigame/platform'

export type PixiResizeMetrics = {
  width: number
  height: number
  pixelRatio: number
}

export type PixiHighDpiOptions = DisplayScaleOptions & {
  app: Application
  container: HTMLElement
  onResize?: (metrics: PixiResizeMetrics) => void
  appOptions?: Partial<Omit<ApplicationOptions, 'width' | 'height' | 'resolution' | 'autoDensity' | 'resizeTo'>>
}

export async function initPixiAppWithHighDpi({
  app,
  container,
  onResize,
  appOptions,
  minPixelRatio = 1,
  maxPixelRatio = 2,
}: PixiHighDpiOptions): Promise<() => void> {
  let frameId: number | null = null

  const getMetrics = (): PixiResizeMetrics => {
    // Prefer visualViewport on mobile — it reports the ACTUAL visible
    // area excluding the address bar / system gesture region, which is
    // what we want the canvas resolution to match. Without this the
    // container's CSS `100%` resolves against the LAYOUT viewport
    // (which includes the URL-bar area even when hidden), so Pixi
    // renders ~60px more content than the screen actually shows and
    // squashes everything vertically.
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined
    const visualW = vv ? Math.round(vv.width) : 0
    const visualH = vv ? Math.round(vv.height) : 0
    const containerW = container.clientWidth || Math.round(window.innerWidth) || 1
    const containerH = container.clientHeight || Math.round(window.innerHeight) || 1
    const width = Math.max(1, visualW || containerW)
    const height = Math.max(1, visualH || containerH)
    const rawPixelRatio = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1
    const low = Math.min(minPixelRatio, maxPixelRatio)
    const high = Math.max(minPixelRatio, maxPixelRatio)

    return {
      width,
      height,
      pixelRatio: Math.max(low, Math.min(rawPixelRatio || 1, high)),
    }
  }

  const applyMetrics = () => {
    const metrics = getMetrics()
    app.renderer.resize(metrics.width, metrics.height, metrics.pixelRatio)
    onResize?.(metrics)
  }

  const initial = getMetrics()

  await app.init({
    ...appOptions,
    width: initial.width,
    height: initial.height,
    resolution: initial.pixelRatio,
    autoDensity: true,
  })

  onResize?.(initial)

  const scheduleApply = () => {
    if (frameId !== null) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      applyMetrics()
    })
  }

  const removeDisplayChange = onDisplayChange(() => {
    scheduleApply()
  }, { minPixelRatio, maxPixelRatio })

  return () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    removeDisplayChange()
  }
}
