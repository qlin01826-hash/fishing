import { Container, Graphics, Text, TextStyle } from 'pixi.js'

/**
 * Full-screen "FISH FRENZY!" celebration overlay.
 *
 * BattleState calls {@link activate} the instant the tension-bar safe
 * zone hits 100% width, and {@link deactivate} when the frenzy window
 * elapses (or the player lets the zone collapse). The overlay paints:
 *
 *   - a soft golden vignette around the screen edges that pulses on
 *     the audio beat (lets the player feel the music more strongly)
 *   - a chunky "FISH FRENZY!" banner that bounces in from the top,
 *     holds while frenzy is active, and slides out on end
 *   - a "x2 SCORE" tag underneath so the reward is unambiguous
 *
 * The overlay is purely cosmetic — gameplay multipliers (faster
 * willpower drain, score bonus, music intensity bump) are owned by
 * BattleState. Keeping the visual layer separate means rebalancing
 * frenzy doesn't risk touching render code.
 */
export class FrenzyOverlay {
  readonly container = new Container()

  private readonly vignette = new Graphics()
  private readonly bannerBg = new Graphics()
  private readonly bannerLabel: Text
  private readonly bannerSub: Text
  private readonly bannerGroup = new Container()

  private width = 1
  private height = 1
  private state: 'hidden' | 'entering' | 'active' | 'exiting' = 'hidden'
  private animT = 0
  /** Smoothed pulse intensity used by the vignette (0..1). */
  private pulse = 0

  constructor() {
    this.bannerLabel = new Text({
      text: 'FISH FRENZY!',
      style: new TextStyle({
        fontSize: 44,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '900',
        fill: '#fff7c0',
        stroke: { color: 0x6a3000, width: 6 },
      }),
    })
    this.bannerLabel.anchor.set(0.5, 0.5)
    this.bannerSub = new Text({
      text: 'x2 SCORE  ·  -精力 3x',
      style: new TextStyle({
        fontSize: 16,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill: '#ffd166',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.bannerSub.anchor.set(0.5, 0.5)

    this.bannerGroup.addChild(this.bannerBg, this.bannerLabel, this.bannerSub)
    this.container.addChild(this.vignette, this.bannerGroup)
    this.container.visible = false
    // Don't intercept any pointer events — purely cosmetic.
    this.container.eventMode = 'none'
  }

  setLayout(width: number, height: number): void {
    this.width = width
    this.height = height
    this.layoutBanner()
    this.drawVignette(0)
  }

  /** Trigger frenzy start. Idempotent — safe to call repeatedly. */
  activate(): void {
    if (this.state === 'entering' || this.state === 'active') return
    this.state = 'entering'
    this.animT = 0
    this.container.visible = true
  }

  /** Trigger frenzy end. Idempotent. */
  deactivate(): void {
    if (this.state === 'hidden' || this.state === 'exiting') return
    this.state = 'exiting'
    this.animT = 0
  }

  isActive(): boolean {
    return this.state === 'entering' || this.state === 'active'
  }

  /**
   * Per-frame update.
   * @param beatPulse 0..1 — peaks just after each base-beat downbeat.
   *                  Drives the vignette pulse so the player FEELS the
   *                  music in their peripheral vision.
   */
  update(dtSeconds: number, beatPulse: number): void {
    if (this.state === 'hidden') {
      if (this.container.visible) this.container.visible = false
      return
    }
    this.animT += dtSeconds

    let bannerProgress = 0
    let bannerAlpha = 1
    if (this.state === 'entering') {
      const p = Math.min(1, this.animT / 0.35)
      bannerProgress = 1 - Math.pow(1 - p, 3) // ease-out cubic
      if (p >= 1) {
        this.state = 'active'
        this.animT = 0
      }
    } else if (this.state === 'active') {
      bannerProgress = 1
      // Gentle bobbing breath while held
      const bob = Math.sin(this.animT * 6) * 4
      this.bannerGroup.position.y = this.bannerBaseY() + bob
    } else if (this.state === 'exiting') {
      const p = Math.min(1, this.animT / 0.45)
      bannerProgress = 1 - p * p
      bannerAlpha = 1 - p
      if (p >= 1) {
        this.state = 'hidden'
        this.container.visible = false
        this.pulse = 0
        return
      }
    }
    if (this.state !== 'active') {
      // Slide vertically from above into the banner rest position.
      const restY = this.bannerBaseY()
      const startY = -120
      this.bannerGroup.position.y = startY + (restY - startY) * bannerProgress
    }
    this.bannerGroup.alpha = bannerAlpha
    // Slight squash + bounce scale tied to beat pulse so the banner
    // visibly "punches" the camera on every drum hit.
    const scale = 1 + beatPulse * 0.08 + (this.state === 'entering' ? (1 - bannerProgress) * 0.1 : 0)
    this.bannerGroup.scale.set(scale)

    // Vignette pulse: smooth toward beatPulse, then decay when exiting.
    const target = this.state === 'exiting' ? 0 : 0.55 + 0.45 * beatPulse
    this.pulse += (target - this.pulse) * Math.min(1, dtSeconds * 8)
    this.drawVignette(this.pulse * bannerAlpha)
  }

  private bannerBaseY(): number {
    // ~14% from top of the screen so it sits above the playfield without
    // clobbering the tension bar.
    return Math.max(80, this.height * 0.16)
  }

  private layoutBanner(): void {
    this.bannerGroup.position.set(this.width / 2, this.bannerBaseY())
    const bw = Math.min(480, this.width - 60)
    const bh = 92
    this.bannerBg.clear()
    this.bannerBg.roundRect(-bw / 2, -bh / 2, bw, bh, 16)
    this.bannerBg.fill({ color: 0x2a1500, alpha: 0.82 })
    this.bannerBg.stroke({ color: 0xffd166, width: 3, alpha: 0.95 })
    this.bannerLabel.position.set(0, -10)
    this.bannerSub.position.set(0, 24)
  }

  private drawVignette(intensity: number): void {
    this.vignette.clear()
    if (intensity <= 0.001) return
    const w = this.width
    const h = this.height
    const a = Math.min(1, intensity)
    // Four warm-gold edge strips. Pixi's Graphics has no real gradient
    // primitive, so we stack three rectangles per edge with decreasing
    // alpha to fake a soft falloff.
    const layers: Array<[number, number]> = [
      [60, 0.42 * a],
      [120, 0.22 * a],
      [200, 0.10 * a],
    ]
    const color = 0xffb84a
    for (const [thickness, alpha] of layers) {
      // Top
      this.vignette.rect(0, 0, w, thickness)
      this.vignette.fill({ color, alpha })
      // Bottom
      this.vignette.rect(0, h - thickness, w, thickness)
      this.vignette.fill({ color, alpha })
      // Left
      this.vignette.rect(0, 0, thickness, h)
      this.vignette.fill({ color, alpha })
      // Right
      this.vignette.rect(w - thickness, 0, thickness, h)
      this.vignette.fill({ color, alpha })
    }
  }
}
