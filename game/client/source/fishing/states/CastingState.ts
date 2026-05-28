import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import { SinkingState } from './SinkingState'
import { SailingState } from './SailingState'

/**
 * Drag-to-cast charge phase.
 *
 * Power formula (per spec):
 *   power = swipe_speed_component + sustained_duration_component
 * NOT dragged distance. We sample `PointerTracker.instantSpeed` over a
 * short history and also accrue a "duration bonus" while the finger is
 * moving. Freezing the finger for >200ms zeroes the charge.
 *
 * Direction is taken at release time from the vector
 * (start_position → release_position).
 */
export class CastingState implements IFishingState {
  readonly id: FishingStateId = 'casting'
  private readonly ctx: FishingContext
  private power = 0
  private chargeAccum = 0
  private lastSpeedAt = 0

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.power = 0
    this.chargeAccum = 0
    this.lastSpeedAt = performance.now()
    this.ctx.castPreview.setVisible(true)
    this.ctx.penguin.showMessage(t('game.castHint'), 'neutral', 2400)
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    const tracker = this.ctx.pointer
    if (!tracker.active) {
      // Pointer released without our `onPointerUp` somehow (e.g. lost
      // capture). Fall back to sailing.
      this.ctx.castPreview.hide()
      this.ctx.goTo(new SailingState(this.ctx))
      return
    }
    const now = performance.now()

    const idleMs = tracker.msSinceLastSample(now)
    if (idleMs > FISHING_CONSTANTS.charge_idle_ms) {
      // Anti-cheat: standing still nukes the charge so the player has
      // to genuinely sweep the pointer back and forth.
      this.power = 0
      this.chargeAccum = 0
    }

    const speed = tracker.instantSpeed(now)
    // Map 0..2500 px/s of finger speed to 0..0.7 charge contribution
    const speedComponent = Math.min(0.7, speed / 2500 * 0.7)
    // Held time builds a slow secondary contribution (max +0.6 over 2s of motion)
    if (speed > 100) {
      this.chargeAccum = Math.min(0.6, this.chargeAccum + dtSeconds * 0.4)
    } else {
      this.chargeAccum = Math.max(0, this.chargeAccum - dtSeconds * 0.6)
    }
    const target = Math.min(FISHING_CONSTANTS.maxPower, speedComponent + this.chargeAccum)
    this.power += (target - this.power) * Math.min(1, dtSeconds * 6)

    this.updatePreview()
    void this.lastSpeedAt
  }

  onPointerMove(x: number, y: number, pointerId: number): void {
    this.ctx.pointer.pointerMove(x, y, pointerId, performance.now())
  }

  onPointerUp(_x: number, _y: number, pointerId: number): void {
    this.ctx.pointer.pointerUp(pointerId)
    if (this.power < 0.08) {
      // Limp release: abort and let the player try again.
      this.ctx.castPreview.hide()
      this.ctx.goTo(new SailingState(this.ctx))
      return
    }
    const { vx, vy } = this.computeLaunchVelocity()
    const targetDepthY = this.computeTargetDepthY()
    this.ctx.audio.playCast(this.power)
    this.ctx.hook.launch(vx, vy, targetDepthY)
    this.ctx.castPreview.hide()
    this.ctx.goTo(new SinkingState(this.ctx))
  }

  exit(): void {
    this.ctx.castPreview.hide()
  }

  // ---- helpers ----

  private updatePreview(): void {
    const { boat, viewport, weatherSystem, castPreview } = this.ctx
    const { vx, vy } = this.computeLaunchVelocity()
    const maxDepthY = viewport.waterLineY + viewport.maxDepth
    castPreview.setPreview(
      boat.rodTipX,
      boat.rodTipY,
      this.power,
      vx,
      vy,
      weatherSystem.get().windPush,
      maxDepthY,
    )
  }

  private computeLaunchVelocity(): { vx: number; vy: number } {
    const { pointer, viewport } = this.ctx
    const { dx, dy } = pointer.totalDelta()
    // Direction: the player flicks the rod forward — drag direction IS
    // the cast direction (think of swinging a rod, not pulling a
    // slingshot). Previously we inverted (`ux = -dx/len`) which made
    // every cast fly opposite to the player's intent.
    const len = Math.max(1, Math.hypot(dx, dy))
    const ux = dx / len
    const uy = dy / len
    // Scale max speed to the viewport so the lure can't fly off-screen
    // on small displays. 240 floor keeps very small phones playable.
    const speedMax = Math.min(820, Math.max(240, viewport.width * 0.4))
    const speed = 200 + this.power * (speedMax - 200)
    // Force a minimum upward component so the arc is always visible
    // no matter which direction the player flicked.
    const vy = Math.min(uy, -0.35) * speed
    const vx = ux * speed
    return { vx, vy }
  }

  private computeTargetDepthY(): number {
    const { viewport } = this.ctx
    return viewport.waterLineY + viewport.maxDepth * this.power
  }
}
