import { Container, Graphics } from 'pixi.js'
import type { ViewportContext } from '../types'

/**
 * AbyssOverlay — a full-screen "pressure" vignette that intensifies as
 * the run descends the depth ladder. It darkens the screen edges and
 * lays a faint cold tint over the whole scene so the deepest stages
 * feel claustrophobic and ominous (the "abyss challenge" mood).
 *
 * Mounted at the very top of the above-water layer (above fog, below
 * the UI) so it dims the seascape and boat without ever muddying the
 * HUD or rhythm UI.
 *
 * Cheap to draw: a stack of nested rectangle strokes that fade inward
 * plus one low-alpha tint fill — only redrawn when the mood or the
 * viewport actually changes.
 */
export class AbyssOverlay {
  readonly container = new Container()
  private readonly graphics = new Graphics()
  private viewport: ViewportContext
  private mood = 0
  private lastDrawnMood = -1
  private lastW = -1
  private lastH = -1

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.container.addChild(this.graphics)
    this.container.eventMode = 'none'
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
  }

  /** 0 = bright shallows (overlay off), 1 = deepest abyss. */
  setMood(t: number): void {
    this.mood = Math.max(0, Math.min(1, t))
  }

  update(): void {
    const { width, height } = this.viewport
    // Only repaint when something meaningful changed.
    if (
      Math.abs(this.mood - this.lastDrawnMood) < 0.01 &&
      width === this.lastW &&
      height === this.lastH
    ) {
      return
    }
    this.lastDrawnMood = this.mood
    this.lastW = width
    this.lastH = height

    const g = this.graphics
    g.clear()
    if (this.mood <= 0.001) {
      this.container.visible = false
      return
    }
    this.container.visible = true

    // Faint cold tint over the whole frame — a deep-pressure blue-black.
    g.rect(0, 0, width, height)
    g.fill({ color: 0x020912, alpha: this.mood * 0.16 })

    // Edge vignette: nested rectangle borders that darken toward the
    // screen edge. `rings` strokes of `step` width cover the border band.
    const rings = 16
    const step = Math.max(4, Math.round(Math.min(width, height) * 0.012))
    const maxAlpha = this.mood * 0.6
    for (let i = 0; i < rings; i += 1) {
      const inset = i * step
      const w = width - inset * 2
      const h = height - inset * 2
      if (w <= 0 || h <= 0) break
      // Strongest at the very edge, easing toward the centre.
      const k = 1 - i / rings
      const alpha = maxAlpha * k * k
      g.rect(inset, inset, w, h)
      g.stroke({ color: 0x000308, width: step + 1, alpha })
    }
  }
}
