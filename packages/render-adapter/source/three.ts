import { getRecommendedPixelRatio, onDisplayChange } from '@minigame/platform'
import type { DisplayScaleOptions } from '@minigame/platform'

export type ThreeResizeMetrics = {
  width: number
  height: number
  pixelRatio: number
}

export type ThreeHighDpiOptions = DisplayScaleOptions & {
  container: HTMLElement
  renderer: {
    setPixelRatio: (value: number) => void
    setSize: (width: number, height: number) => void
  }
  onResize?: (metrics: ThreeResizeMetrics) => void
}

export function installThreeHighDpi({
  container,
  renderer,
  onResize,
  ...displayOptions
}: ThreeHighDpiOptions): () => void {
  let frameId: number | null = null

  const apply = () => {
    const width = Math.max(1, container.clientWidth || Math.round(window.innerWidth))
    const height = Math.max(1, container.clientHeight || Math.round(window.innerHeight))
    const pixelRatio = getRecommendedPixelRatio(displayOptions)

    renderer.setPixelRatio(pixelRatio)
    renderer.setSize(width, height)
    onResize?.({ width, height, pixelRatio })
  }

  const scheduleApply = () => {
    if (frameId !== null) return

    frameId = window.requestAnimationFrame(() => {
      frameId = null
      apply()
    })
  }

  apply()

  const removeDisplayChange = onDisplayChange(() => {
    scheduleApply()
  }, displayOptions)

  return () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId)
      frameId = null
    }

    removeDisplayChange()
  }
}
