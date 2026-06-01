import { Container, Graphics } from 'pixi.js'
import type { ViewportContext } from '../types'

interface BubbleTrail {
  x: number
  y: number
  age: number
  life: number
  radius: number
}

/**
 * The hook + line + bait + bubble trail.
 *
 * Owns its own world-space position so the scene can ask "where is the
 * hook now?" without reaching through Pixi containers. The fishing line
 * is redrawn each frame as a slack curve from `rodTipX/Y` to the hook.
 *
 * Physics modes (set via `setMode`):
 *   - `idle`   : hook attached to the rod, no separate position
 *   - `flight` : ballistic with gravity + wind (used during cast arc)
 *   - `water`  : underwater, with drag turning into a slow constant sink
 *   - `hover`  : reached target depth, hovering with small jitter
 *   - `fight`  : during battle, the bobber wiggles but doesn't fall
 */
export type HookMode = 'idle' | 'flight' | 'water' | 'hover' | 'fight'

export class Hook {
  readonly container = new Container()

  /** World position of the hook itself. */
  x = 0
  y = 0
  vx = 0
  vy = 0
  /** Where the line attaches on the boat side. */
  rodTipX = 0
  rodTipY = 0

  private readonly line = new Graphics()
  private readonly sinker = new Graphics()
  private readonly bait = new Graphics()
  private readonly splash = new Graphics()
  private readonly bubbles = new Graphics()

  private mode: HookMode = 'idle'
  private trail: BubbleTrail[] = []
  private targetDepthY = 0
  private splashTimer = 0
  /** Subtle bobber jitter, randomised each frame in water. */
  private wiggle = 0
  /**
   * Line tautness 0..1, set by BattleState from the beat-synced "tug"
   * envelope. 0 = the usual slack sag curve; 1 = the line snaps nearly
   * straight and twangs. Lets the fishing line visibly react in rhythm
   * as the fish is reeled in.
   */
  private lineTension = 0
  /** Externally-applied per-frame nudge during the fight (px, world). */
  fightOffsetX = 0
  fightOffsetY = 0

  constructor() {
    this.container.addChild(this.line, this.sinker, this.bait, this.bubbles, this.splash)
    this.splash.alpha = 0
    this.draw()
  }

  setMode(mode: HookMode): void {
    this.mode = mode
    if (mode === 'flight' || mode === 'idle') {
      this.bubbles.clear()
      this.trail.length = 0
      this.lineTension = 0
    }
  }

  /**
   * 0 = slack line (default sag curve), 1 = line snapped taut + twang.
   * BattleState drives this from its per-beat tug envelope.
   */
  setLineTension(amount: number): void {
    this.lineTension = Math.max(0, Math.min(1, amount))
  }

  getMode(): HookMode {
    return this.mode
  }

  resetToRod(rodTipX: number, rodTipY: number): void {
    this.rodTipX = rodTipX
    this.rodTipY = rodTipY
    this.x = rodTipX
    this.y = rodTipY
    this.vx = 0
    this.vy = 0
    this.targetDepthY = rodTipY
    this.splashTimer = 0
    this.splash.alpha = 0
    this.trail.length = 0
    this.bubbles.clear()
    this.lineTension = 0
    this.mode = 'idle'
  }

  launch(vx: number, vy: number, targetDepthY: number): void {
    this.vx = vx
    this.vy = vy
    this.targetDepthY = targetDepthY
    this.mode = 'flight'
  }

  triggerSplash(): void {
    this.splashTimer = 0.4
  }

  /** Pull the hook upward by `amount` px (used by REEL button). */
  twitchUp(amount: number): void {
    if (this.mode === 'water' || this.mode === 'hover') {
      this.vy -= amount
      // Clamp upward speed so a spammed reel doesn't yank the hook out of water
      const maxUp = -160
      if (this.vy < maxUp) this.vy = maxUp
    }
  }

  update(
    dtSeconds: number,
    viewport: ViewportContext,
    rodTipX: number,
    rodTipY: number,
    windPush: number,
  ): void {
    this.rodTipX = rodTipX
    this.rodTipY = rodTipY

    if (this.mode === 'idle') {
      this.x = rodTipX
      this.y = rodTipY
    } else if (this.mode === 'flight') {
      // Gravity + horizontal wind
      this.vy += 1100 * dtSeconds
      this.vx += windPush * dtSeconds
      this.x += this.vx * dtSeconds
      this.y += this.vy * dtSeconds
      // Hit the waterline?
      if (this.y >= viewport.waterLineY) {
        this.y = viewport.waterLineY
        this.mode = 'water'
        this.triggerSplash()
        // Convert horizontal velocity to a small leftover drift, vertical to a strong sink impulse.
        this.vx *= 0.15
        this.vy = Math.max(140, this.vy * 0.5)
      }
    } else if (this.mode === 'water') {
      // Water drag — exponential decay toward terminal slow sink
      const dragX = Math.exp(-1.8 * dtSeconds)
      const dragY = Math.exp(-1.4 * dtSeconds)
      this.vx *= dragX
      this.vy = this.vy * dragY + 18 * (1 - dragY) // ease toward 18 px/s
      this.x += this.vx * dtSeconds
      this.y += this.vy * dtSeconds
      // Settle into hover at target depth
      if (this.y >= this.targetDepthY) {
        this.y = this.targetDepthY
        this.vy = 0
        this.mode = 'hover'
      }
      this.emitBubble(dtSeconds, 30)
    } else if (this.mode === 'hover') {
      this.wiggle += dtSeconds
      this.x += Math.sin(this.wiggle * 1.6) * 0.4
      this.y += Math.sin(this.wiggle * 2.3) * 0.25
      this.emitBubble(dtSeconds, 6)
    } else if (this.mode === 'fight') {
      this.wiggle += dtSeconds
      this.x += this.fightOffsetX
      this.y += this.fightOffsetY + Math.sin(this.wiggle * 8) * 0.6
      this.fightOffsetX = 0
      this.fightOffsetY = 0
      this.emitBubble(dtSeconds, 18)
    }

    // Don't go above water surface in water modes (the hook should stay wet)
    if (this.mode === 'water' || this.mode === 'hover' || this.mode === 'fight') {
      if (this.y < viewport.waterLineY + 4) {
        this.y = viewport.waterLineY + 4
        this.vy = Math.max(this.vy, 0)
      }
    }

    // Update trail / drawing
    this.advanceTrail(dtSeconds)
    this.draw()
    this.drawLine()
    if (this.splashTimer > 0) {
      this.splashTimer -= dtSeconds
      this.drawSplash(viewport)
    } else {
      this.splash.alpha = 0
    }
  }

  /** Convenience: true if the hook is somewhere in the water column. */
  isInWater(viewport: ViewportContext): boolean {
    return this.y >= viewport.waterLineY
  }

  private emitBubble(dtSeconds: number, density: number): void {
    if (Math.random() < dtSeconds * density) {
      this.trail.push({
        x: this.x + (Math.random() - 0.5) * 4,
        y: this.y - 4,
        age: 0,
        life: 1.0 + Math.random() * 0.6,
        radius: 1 + Math.random() * 2,
      })
    }
  }

  private advanceTrail(dtSeconds: number): void {
    if (this.trail.length === 0) {
      this.bubbles.clear()
      return
    }
    const next: BubbleTrail[] = []
    for (const b of this.trail) {
      b.age += dtSeconds
      b.y -= dtSeconds * 18
      if (b.age < b.life) next.push(b)
    }
    this.trail = next
    const g = this.bubbles
    g.clear()
    for (const b of this.trail) {
      const a = 1 - b.age / b.life
      g.circle(b.x, b.y, b.radius)
      g.fill({ color: 0xffffff, alpha: 0.35 * a })
    }
  }

  private draw(): void {
    const g = this.sinker
    g.clear()
    g.circle(this.x, this.y, 4)
    g.fill(0x303030)
    const b = this.bait
    b.clear()
    // J-shaped hook with a tiny red bait worm
    b.moveTo(this.x, this.y + 1)
    b.lineTo(this.x, this.y + 9)
    b.arc(this.x - 3, this.y + 9, 3, 0, Math.PI)
    b.stroke({ color: 0xc8c8c8, width: 1.6 })
    b.circle(this.x - 5, this.y + 11, 2.2)
    b.fill(0xff6b6b)
  }

  private drawLine(): void {
    const g = this.line
    g.clear()
    const dx = this.x - this.rodTipX
    const dy = this.y - this.rodTipY
    const len = Math.hypot(dx, dy)
    // Slack sag curve via quadratic through a dropped midpoint. Tension
    // pulls the sag out so the line snaps progressively straight.
    const baseSag = Math.min(40, len * 0.08 + 6)
    const sag = baseSag * (1 - this.lineTension * 0.85)
    let midX = (this.rodTipX + this.x) / 2
    let midY = (this.rodTipY + this.y) / 2 + sag
    // Twang: when taut, vibrate the control point PERPENDICULAR to the
    // line so it reads as a plucked string shuddering under load.
    if (this.lineTension > 0.05 && len > 1) {
      const perpX = -dy / len
      const perpY = dx / len
      const twang = Math.sin(this.wiggle * 90) * this.lineTension * 4
      midX += perpX * twang
      midY += perpY * twang
    }
    g.moveTo(this.rodTipX, this.rodTipY)
    g.quadraticCurveTo(midX, midY, this.x, this.y)
    // Taut line reads brighter + a touch thicker, like it's straining.
    const width = 1.2 + this.lineTension * 0.8
    const alpha = 0.6 + this.lineTension * 0.35
    g.stroke({ color: 0xffffff, width, alpha })
  }

  private drawSplash(viewport: ViewportContext): void {
    const g = this.splash
    g.clear()
    const t = 1 - this.splashTimer / 0.4
    const radius = 6 + t * 28
    g.circle(this.x, viewport.waterLineY, radius)
    g.stroke({ color: 0xffffff, width: 2, alpha: 1 - t })
    g.circle(this.x, viewport.waterLineY, radius * 0.6)
    g.stroke({ color: 0xffffff, width: 1.5, alpha: (1 - t) * 0.7 })
    this.splash.alpha = 1
  }
}
