import { Container, Graphics } from 'pixi.js'
import type { ViewportContext } from '../types'

/**
 * Cinematic "Fish Frenzy" cameo whale.
 *
 * BattleState calls {@link appear} the moment a frenzy starts; the whale
 * slides in from one side of the screen at deep-water depth, drifts
 * majestically across in front of the depth gradient, and slides out
 * the opposite edge — at which point it auto-disables until the next
 * frenzy. {@link dismiss} can also be called early (e.g. on battle end)
 * to fade it out.
 *
 * It is purely a silhouette + a single eye highlight — meant to read as
 * "something enormous moving down there" without competing with the
 * battle-critical fish school for attention.
 */
export class Whale {
  readonly container = new Container()
  /**
   * Separate spout container — needs to live ABOVE the water surface,
   * not buried under the depth gradient like the body. FishingScene
   * mounts this in the same layer as the splash particles.
   */
  readonly spoutContainer = new Container()
  private readonly body = new Graphics()
  private readonly spoutGraphics = new Graphics()
  /** True while the whale should be on-screen (drives the alpha lerp). */
  private active = false
  /** 0..1 fade alpha (lerps toward 1 when active, toward 0 when not). */
  private alpha = 0
  private x = 0
  private y = 0
  /** Direction of horizontal travel: 1 = swims right, -1 = swims left. */
  private direction: 1 | -1 = 1
  private bornAtMs = 0
  /** Used to keep the silhouette anchored against viewport resizes. */
  private viewportSnapshot: ViewportContext | null = null
  /** Active spout particles (water droplets). */
  private spoutDrops: Array<{
    x: number
    y: number
    vx: number
    vy: number
    /** 1→0 lifetime. */
    t: number
    size: number
  }> = []
  /** Cached previous-frame beat phase for downbeat-edge spout firing. */
  private prevBeatPhase = 0.5

  constructor() {
    this.container.addChild(this.body)
    this.container.visible = false
    this.container.eventMode = 'none'
    this.spoutContainer.addChild(this.spoutGraphics)
    this.spoutContainer.eventMode = 'none'
    this.drawSilhouette()
  }

  /**
   * Begin a fresh whale pass. Picks a random side to enter from and
   * resets the lifetime clock. Idempotent while already swimming —
   * subsequent calls just keep the current pass going.
   */
  appear(viewport: ViewportContext): void {
    this.viewportSnapshot = viewport
    if (this.active) return
    this.active = true
    this.direction = Math.random() < 0.5 ? 1 : -1
    this.x = this.direction === 1 ? -260 : viewport.width + 260
    this.y = viewport.waterLineY + viewport.maxDepth * 0.7
    this.bornAtMs = performance.now()
  }

  /** Begin fade-out. Safe to call repeatedly. */
  dismiss(): void {
    this.active = false
  }

  setViewport(viewport: ViewportContext): void {
    this.viewportSnapshot = viewport
    if (this.active) {
      // Re-anchor depth as the viewport reshapes — don't reset X so
      // the cross-screen pass continues unbroken.
      this.y = viewport.waterLineY + viewport.maxDepth * 0.7
    }
  }

  /**
   * @param beatPhase 0..1 — pumped in each frame by FishingScene so the
   *                  whale's blowhole fires a spout on every downbeat
   *                  while it's on-screen. Same edge-detection trick
   *                  as FishSchool splashes.
   */
  update(dtSeconds: number, beatPhase = 0.5): void {
    const vp = this.viewportSnapshot
    if (!vp) return

    const target = this.active ? 1 : 0
    this.alpha += (target - this.alpha) * Math.min(1, dtSeconds * 1.2)
    if (this.alpha < 0.005 && !this.active) {
      if (this.container.visible) this.container.visible = false
      // Keep ticking spout drops even after the body fades so any
      // in-flight droplets gracefully fall back to the sea.
      this.tickSpout(dtSeconds, vp, 0)
      return
    }
    this.container.visible = true
    this.container.alpha = this.alpha * 0.75

    // Slow, majestic cruise.
    this.x += this.direction * 50 * dtSeconds

    // Gentle vertical drift so it doesn't read as a flat sprite slide.
    const t = (performance.now() - this.bornAtMs) / 1000
    const yDrift = Math.sin(t * 0.6) * 28
    const bodyY = this.y + yDrift

    this.container.position.set(this.x, bodyY)
    this.container.scale.x = this.direction

    // Downbeat edge → fire a spout burst from the blowhole, but only
    // while the whale is actually visible.
    const isDownbeat =
      (this.prevBeatPhase > 0.6 && beatPhase < 0.4) ||
      beatPhase < this.prevBeatPhase - 0.5
    if (isDownbeat && this.alpha > 0.4) {
      // Blowhole sits a bit forward of body centre (~20 units toward
      // the head) and just above the back.
      const blowOffsetX = 20 * this.direction
      const blowX = this.x + blowOffsetX
      const blowTopY = bodyY - 48
      this.spawnSpout(blowX, blowTopY)
    }
    this.prevBeatPhase = beatPhase
    this.tickSpout(dtSeconds, vp, this.alpha)

    // Auto-dismiss once the whale has fully exited the opposite edge.
    const exitedRight = this.direction === 1 && this.x > vp.width + 280
    const exitedLeft = this.direction === -1 && this.x < -280
    if (exitedRight || exitedLeft) this.active = false
  }

  /** Fire a fresh column of water droplets at (cx, cy). */
  private spawnSpout(cx: number, cy: number): void {
    // ~12 main drops shooting straight up with slight spread, plus a
    // thicker base mist for the column feel.
    for (let i = 0; i < 14; i += 1) {
      const spreadX = (Math.random() - 0.5) * 12
      const upSpeed = 220 + Math.random() * 120
      this.spoutDrops.push({
        x: cx + spreadX,
        y: cy + 10,
        vx: spreadX * 1.6,
        vy: -upSpeed,
        t: 1,
        size: 2 + Math.random() * 2,
      })
    }
    // A few wider-spread misty drops for the "fan" effect at the top.
    for (let i = 0; i < 6; i += 1) {
      const spread = (Math.random() - 0.5) * 60
      this.spoutDrops.push({
        x: cx,
        y: cy,
        vx: spread * 1.6,
        vy: -120 - Math.random() * 80,
        t: 1,
        size: 1.4 + Math.random() * 1.6,
      })
    }
  }

  /**
   * Advance + render the spout droplets. They obey a simple gravity
   * model so the column rises, fans out, and falls back into the sea.
   */
  private tickSpout(dtSeconds: number, vp: ViewportContext, alphaScale: number): void {
    const gravity = 480
    for (const d of this.spoutDrops) {
      d.vy += gravity * dtSeconds
      d.x += d.vx * dtSeconds
      d.y += d.vy * dtSeconds
      d.t -= dtSeconds * 0.9
    }
    this.spoutDrops = this.spoutDrops.filter(
      (d) => d.t > 0 && d.y < vp.waterLineY + 20,
    )

    const g = this.spoutGraphics
    g.clear()
    if (this.spoutDrops.length === 0) return
    for (const d of this.spoutDrops) {
      const a = Math.min(1, d.t) * Math.max(0.2, alphaScale)
      g.circle(d.x, d.y, d.size)
      g.fill({ color: 0xfff7e1, alpha: a })
    }
    // Faint upward streaks at the base for the "column" silhouette.
    if (this.alpha > 0.4) {
      for (const d of this.spoutDrops) {
        if (d.vy >= -40) continue
        const a = Math.min(1, d.t) * 0.35 * alphaScale
        g.moveTo(d.x, d.y)
        g.lineTo(d.x - d.vx * dtSeconds * 4, d.y - d.vy * dtSeconds * 4)
        g.stroke({ color: 0xffffff, width: 1.2, alpha: a })
      }
    }
  }

  /**
   * Hand-drawn silhouette — head at +x so `scale.x = direction` does
   * the right thing for both swim directions.
   */
  private drawSilhouette(): void {
    const g = this.body
    g.clear()
    // Main body — long ellipse, head on the right.
    g.ellipse(0, 0, 180, 48)
    g.fill({ color: 0x051628, alpha: 0.92 })
    // Tail flukes on the left, two lobes giving a clean horizontal V.
    g.poly([-150, 0, -212, -34, -198, -2])
    g.fill({ color: 0x051628, alpha: 0.92 })
    g.poly([-150, 0, -212, 34, -198, 2])
    g.fill({ color: 0x051628, alpha: 0.92 })
    // Pectoral fin (subtle, just sketched under the body).
    g.ellipse(-30, 38, 40, 14)
    g.fill({ color: 0x051628, alpha: 0.85 })
    // Dorsal fin on top.
    g.poly([10, -44, 36, -58, 50, -44])
    g.fill({ color: 0x051628, alpha: 0.85 })
    // Belly highlight — slightly lighter to suggest light filtering down.
    g.ellipse(0, 26, 140, 14)
    g.fill({ color: 0x103252, alpha: 0.55 })
    // Top highlight ridge so it reads as "lit from above".
    g.ellipse(20, -36, 80, 6)
    g.fill({ color: 0x2a5080, alpha: 0.4 })
    // Eye — small white dot with a black pupil for personality.
    g.circle(108, -10, 4)
    g.fill({ color: 0xfff7c0, alpha: 0.9 })
    g.circle(108, -10, 2)
    g.fill(0x000000)
  }
}
