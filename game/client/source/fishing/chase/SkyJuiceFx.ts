import type { Graphics } from 'pixi.js'

/**
 * Screen-space "game juice" particle layer for the sky-stream tracking feel.
 *
 * Two synced systems, all drawn into an ADDITIVE graphics layer so they read as
 * glowing light:
 *  - **Burning-edge bubbles**: cavitation spray flung backward from the Z=0
 *    contact point — the track is being "melted/eaten" as the finger crosses it.
 *  - **Reward pearls**: gold/teal score motes spawned around the fingertip that
 *    home into the diver's body (energy being devoured), popping a gold ripple
 *    on arrival.
 *
 * Counts are capped to keep the cost flat (no GC spikes on phones).
 */

interface Bubble {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
  size: number
  blue: boolean
}

interface Pearl {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  gold: boolean
  size: number
}

interface Ripple {
  x: number
  y: number
  life: number
  max: number
}

export interface SkyJuiceInput {
  tracked: boolean
  anchorX: number
  anchorY: number
  anchorValid: boolean
  fingerX: number
  fingerY: number
  fingerValid: boolean
  pengX: number
  pengY: number
}

const BUBBLE_MAX = 46
const PEARL_MAX = 30
const RIPPLE_MAX = 6
const BURN_INTERVAL = 0.028
const PEARL_INTERVAL = 0.05

export class SkyJuiceFx {
  private readonly bubbles: Bubble[] = []
  private readonly pearls: Pearl[] = []
  private readonly ripples: Ripple[] = []
  private burnAccum = 0
  private pearlAccum = 0

  reset(): void {
    this.bubbles.length = 0
    this.pearls.length = 0
    this.ripples.length = 0
    this.burnAccum = 0
    this.pearlAccum = 0
  }

  update(dt: number, input: SkyJuiceInput): void {
    this.spawnBurningEdge(dt, input)
    this.integrateBubbles(dt)
    this.spawnPearls(dt, input)
    this.integratePearls(dt, input)
    this.integrateRipples(dt)
  }

  // ---- burning-edge cavitation bubbles ----

  private spawnBurningEdge(dt: number, input: SkyJuiceInput): void {
    if (!input.tracked || !input.anchorValid) {
      this.burnAccum = 0
      return
    }
    this.burnAccum += dt
    while (this.burnAccum >= BURN_INTERVAL) {
      this.burnAccum -= BURN_INTERVAL
      if (this.bubbles.length >= BUBBLE_MAX) break
      const ang = Math.random() * Math.PI * 2
      const sp = 50 + Math.random() * 110
      this.bubbles.push({
        x: input.anchorX + (Math.random() - 0.5) * 12,
        y: input.anchorY + (Math.random() - 0.5) * 12,
        vx: Math.cos(ang) * sp * 0.55,
        // Bias downward/outward = "backward" past the judge plane.
        vy: Math.abs(Math.sin(ang)) * sp + 40,
        life: 0.34 + Math.random() * 0.22,
        max: 0.56,
        size: 1.6 + Math.random() * 3.2,
        blue: Math.random() < 0.5,
      })
    }
  }

  private integrateBubbles(dt: number): void {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i]
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.vx *= 0.92
      b.vy = b.vy * 0.92 + 70 * dt
      b.life -= dt
      if (b.life <= 0) this.bubbles.splice(i, 1)
    }
  }

  // ---- reward pearls (homing energy intake) ----

  private spawnPearls(dt: number, input: SkyJuiceInput): void {
    if (!input.tracked || !input.fingerValid) {
      this.pearlAccum = 0
      return
    }
    this.pearlAccum += dt
    while (this.pearlAccum >= PEARL_INTERVAL) {
      this.pearlAccum -= PEARL_INTERVAL
      if (this.pearls.length >= PEARL_MAX) break
      const ang = Math.random() * Math.PI * 2
      const rad = Math.random() * 40
      // Tangential kick → curved in-swing toward the diver.
      const tang = ang + Math.PI / 2
      const tsp = 70 + Math.random() * 70
      this.pearls.push({
        x: input.fingerX + Math.cos(ang) * rad,
        y: input.fingerY + Math.sin(ang) * rad,
        vx: Math.cos(tang) * tsp,
        vy: Math.sin(tang) * tsp,
        life: 1.3,
        gold: Math.random() < 0.6,
        size: 2 + Math.random() * 2,
      })
    }
  }

  private integratePearls(dt: number, input: SkyJuiceInput): void {
    const accel = 950
    for (let i = this.pearls.length - 1; i >= 0; i--) {
      const p = this.pearls[i]
      const dx = input.pengX - p.x
      const dy = input.pengY - p.y
      const dist = Math.hypot(dx, dy) || 1
      p.vx += (dx / dist) * accel * dt
      p.vy += (dy / dist) * accel * dt
      p.vx *= 0.9
      p.vy *= 0.9
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.life -= dt
      if (dist < 14 || p.life <= 0) {
        if (dist < 36 && this.ripples.length < RIPPLE_MAX) {
          this.ripples.push({ x: input.pengX, y: input.pengY, life: 0.45, max: 0.45 })
        }
        this.pearls.splice(i, 1)
      }
    }
  }

  private integrateRipples(dt: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].life -= dt
      if (this.ripples[i].life <= 0) this.ripples.splice(i, 1)
    }
  }

  /** Draw into an ADDITIVE-blend graphics layer (cleared by the caller). */
  draw(g: Graphics): void {
    // Arrival ripples on the diver.
    for (const r of this.ripples) {
      const t = 1 - r.life / r.max
      g.circle(r.x, r.y, 6 + t * 34)
      g.stroke({ color: 0xffd870, width: Math.max(0.5, 2.6 * (1 - t)), alpha: (1 - t) * 0.85 })
    }
    // Homing pearls (gold / teal) with a soft halo.
    for (const p of this.pearls) {
      const col = p.gold ? 0xffd86a : 0x66f0e0
      g.circle(p.x, p.y, p.size + 2.5)
      g.fill({ color: col, alpha: 0.22 })
      g.circle(p.x, p.y, p.size)
      g.fill({ color: 0xffffff, alpha: 0.9 })
      g.circle(p.x, p.y, p.size * 0.55)
      g.fill({ color: col, alpha: 0.95 })
    }
    // Burning-edge cavitation bubbles.
    for (const b of this.bubbles) {
      const a = Math.max(0, b.life / b.max)
      g.circle(b.x, b.y, b.size)
      g.fill({ color: b.blue ? 0x9fe8ff : 0xffffff, alpha: a * 0.72 })
    }
  }
}
