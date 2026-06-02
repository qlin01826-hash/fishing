import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { ViewportContext } from '../types'

/**
 * Cast-related UI:
 * - A beat-synced "tap to cast" cue ring on the rod tip while idling at
 *   sea (driven by `SailingState`) — the player taps on its flash.
 * - (Legacy) parabola arc / landing ring / power bar helpers, kept for
 *   any future aimed-cast mode.
 *
 * Pure UI: callers feed it positions/power; it does NOT decide whether a
 * cast is valid.
 */
export class CastPreview {
  readonly container = new Container()

  private readonly arc = new Graphics()
  private readonly ring = new Graphics()
  private readonly powerBg = new Graphics()
  private readonly powerFill = new Graphics()
  private readonly powerLabel: Text
  /** Beat-synced "tap now" cue ring shown while idling at sea. */
  private readonly beatCue = new Graphics()

  private viewport: ViewportContext

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.powerLabel = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 16,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.powerLabel.anchor.set(0.5, 0)
    this.container.addChild(
      this.beatCue,
      this.arc,
      this.ring,
      this.powerBg,
      this.powerFill,
      this.powerLabel,
    )
    this.setVisible(false)
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible
  }

  hide(): void {
    this.setVisible(false)
    this.arc.clear()
    this.ring.clear()
    this.powerFill.clear()
    this.powerBg.clear()
    this.powerLabel.text = ''
    this.beatCue.clear()
  }

  /**
   * Draw the beat-synced "tap to cast" cue at the rod tip. `pulse` is
   * 1.0 right on the beat and eases to 0 between beats — the ring flashes
   * bright + large exactly on each beat, so the player learns to tap on
   * the flash for a perfect on-beat cast.
   */
  showBeatCue(x: number, y: number, pulse: number): void {
    this.setVisible(true)
    const g = this.beatCue
    g.clear()
    const p = Math.max(0, Math.min(1, pulse))
    const baseR = 16
    const r = baseR * (1 + p * 0.7)
    // Outer flashing ring — the "hit window" the player aims their tap at.
    g.circle(x, y, r)
    g.stroke({ color: 0xffe07a, width: 2 + p * 2, alpha: 0.35 + p * 0.6 })
    // Bright core dot pops on the downbeat.
    g.circle(x, y, 3 + p * 3)
    g.fill({ color: 0xffffff, alpha: 0.4 + p * 0.55 })
    // Fixed inner target so the player has a reference size to match.
    g.circle(x, y, baseR * 0.75)
    g.stroke({ color: 0xffe07a, width: 1.5, alpha: 0.5 })
  }

  /**
   * @param power 0..1 — drives bar fill, distance, depth
   * @param vx initial horizontal velocity (px/s)
   * @param vy initial vertical velocity (px/s, negative = up)
   * @param windPush horizontal wind acceleration (px/s^2)
   * @param maxDepthY world y of deepest reachable hover point
   */
  setPreview(
    rodTipX: number,
    rodTipY: number,
    power: number,
    vx: number,
    vy: number,
    windPush: number,
    maxDepthY: number,
  ): void {
    this.setVisible(true)
    const { width, waterLineY } = this.viewport
    // Simulate the cast trajectory: forward Euler with small steps until
    // it hits the water, then convert to predicted depth (depth = power * maxAvailable).
    const stepMs = 14
    const dt = stepMs / 1000
    let x = rodTipX
    let y = rodTipY
    let cvx = vx
    let cvy = vy
    const arcPoints: Array<[number, number]> = [[x, y]]
    let landingX = x
    let landingY = y
    let hitWater = false
    for (let step = 0; step < 400; step += 1) {
      cvy += 1100 * dt
      cvx += windPush * dt
      x += cvx * dt
      y += cvy * dt
      if (y >= waterLineY && !hitWater) {
        landingX = x
        landingY = waterLineY
        hitWater = true
        arcPoints.push([landingX, landingY])
        break
      }
      arcPoints.push([x, y])
      if (x < -50 || x > width + 50 || y > waterLineY + 200) break
    }

    // Draw dotted arc
    const arc = this.arc
    arc.clear()
    for (let i = 0; i < arcPoints.length; i += 2) {
      const [px, py] = arcPoints[i]
      arc.circle(px, py, 2)
      arc.fill({ color: 0xffffff, alpha: 0.7 })
    }

    // Draw landing ring at predicted splash + a smaller ring at predicted depth
    const ring = this.ring
    ring.clear()
    const predictedDepth = waterLineY + (maxDepthY - waterLineY) * power
    if (hitWater) {
      ring.ellipse(landingX, landingY, 24, 6)
      ring.stroke({ color: 0xffefb0, width: 2 })
      ring.ellipse(landingX, landingY, 18, 4)
      ring.stroke({ color: 0xffefb0, width: 1, alpha: 0.6 })
      // Predicted depth marker straight down
      ring.moveTo(landingX, landingY)
      ring.lineTo(landingX, predictedDepth)
      ring.stroke({ color: 0xffefb0, width: 1, alpha: 0.45 })
      ring.circle(landingX, predictedDepth, 5)
      ring.stroke({ color: 0xffefb0, width: 1.5, alpha: 0.7 })
    }

    // Draw power bar near bottom-center
    const barWidth = Math.min(360, width * 0.6)
    const barHeight = 14
    const barX = (width - barWidth) / 2
    const barY = this.viewport.height - 110
    this.powerBg.clear()
    this.powerBg.roundRect(barX, barY, barWidth, barHeight, 6)
    this.powerBg.fill({ color: 0x000000, alpha: 0.5 })
    this.powerBg.stroke({ color: 0xffefb0, width: 1.5, alpha: 0.85 })
    this.powerFill.clear()
    this.powerFill.roundRect(
      barX + 2,
      barY + 2,
      Math.max(0, (barWidth - 4) * power),
      barHeight - 4,
      4,
    )
    const c = power < 0.4 ? 0x7ed957 : power < 0.75 ? 0xf2c94c : 0xeb5757
    this.powerFill.fill(c)
    this.powerLabel.text = t('game.powerHint', { power: String(Math.round(power * 100)) })
    this.powerLabel.position.set(width / 2, barY + barHeight + 6)
  }
}
