import { Container, Graphics } from 'pixi.js'
import type { CameraDynamics, Transform3D } from './Transform3D'

/**
 * Glowing prey silhouette anchored at the far spawn horizon — the chase goal.
 */
export class TargetPreyFish {
  readonly container = new Container()
  private readonly glow = new Graphics()
  private readonly body = new Graphics()
  private tailPhase = 0

  constructor() {
    this.glow.blendMode = 'screen'
    this.container.addChild(this.glow, this.body)
  }

  update(dt: number): void {
    this.tailPhase += dt * 5.5
  }

  draw(
    transform: Transform3D,
    dyn: CameraDynamics,
    nowMs: number,
    tint: number,
  ): void {
    const z = transform.zSpawn
    const worldY = transform.skyChartYToWorldY(0.15)
    const proj = transform.project(0, worldY, z, dyn)
    if (!proj) {
      this.glow.clear()
      this.body.clear()
      return
    }

    const s = proj.scale
    const cx = proj.x
    const cy = proj.y
    const wag = Math.sin(this.tailPhase + nowMs * 0.002) * s * 6
    const pulse = 0.85 + Math.sin(nowMs * 0.004) * 0.15

    this.glow.clear()
    this.body.clear()

    const glowR = s * 28 * pulse
    this.glow.ellipse(cx, cy, glowR * 1.2, glowR * 0.7)
    this.glow.fill({ color: 0xff6666, alpha: 0.22 })
    this.glow.ellipse(cx, cy, glowR * 0.75, glowR * 0.45)
    this.glow.fill({ color: 0xff8888, alpha: 0.35 })
    this.glow.ellipse(cx, cy - s * 2, glowR * 0.35, glowR * 0.22)
    this.glow.fill({ color: 0xffaaaa, alpha: 0.45 })

    const len = s * 22
    const thick = s * 7
    const g = this.body
    g.ellipse(cx, cy, len * 0.55, thick * 0.85)
    g.fill({ color: tint, alpha: 0.88 })
    g.moveTo(cx - len * 0.45, cy)
    g.quadraticCurveTo(cx - len * 0.95 + wag, cy - thick * 0.4, cx - len * 1.15 + wag * 1.2, cy)
    g.quadraticCurveTo(cx - len * 0.75 + wag * 0.6, cy + thick * 0.35, cx - len * 0.45, cy)
    g.closePath()
    g.fill({ color: 0x1a0808, alpha: 0.9 })
    g.moveTo(cx + len * 0.35, cy - thick * 0.25)
    g.lineTo(cx + len * 0.55, cy)
    g.lineTo(cx + len * 0.35, cy + thick * 0.25)
    g.closePath()
    g.fill({ color: 0xffcc88, alpha: 0.75 })
    g.circle(cx - len * 0.15, cy - thick * 0.15, s * 2.2)
    g.fill({ color: 0xff4444, alpha: 0.95 })
  }
}
