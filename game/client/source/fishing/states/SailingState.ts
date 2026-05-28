import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { pickCommissionFish } from '../data/FishCatalog'
import { CastingState } from './CastingState'

/**
 * Idle "we're at sea, waiting" phase.
 *
 * The boat bobs, the penguin posts a commission for a specific fish.
 * Any pointer-down anywhere on the canvas starts a cast.
 */
export class SailingState implements IFishingState {
  readonly id: FishingStateId = 'sailing'
  private readonly ctx: FishingContext

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.castPreview.hide()
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.hide()

    // Roll a fresh commission whenever we re-enter sailing (covers boot
    // and the post-catch return). The penguin's mood reflects hunger.
    if (!this.ctx.commissionFish) {
      this.ctx.commissionFish = pickCommissionFish(this.ctx.hungerSystem.getHunger(), Math.random)
      this.ctx.penguin.showRequest(this.ctx.commissionFish)
    } else {
      this.ctx.penguin.showRequest(this.ctx.commissionFish)
    }
  }

  update(_dtSeconds: number, _elapsedMs: number): void {
    // Mood mapping for the idle penguin (overrides showMessage timers expiring)
    const hunger = this.ctx.hungerSystem.getHunger()
    if (hunger > 0.85) this.ctx.penguin.setMood('weak')
    else if (hunger > 0.6) this.ctx.penguin.setMood('sad')
    else if (hunger > 0.3) this.ctx.penguin.setMood('neutral')
    else this.ctx.penguin.setMood('request')
  }

  onPointerDown(x: number, y: number, pointerId: number): void {
    // Tapping anywhere starts the cast charge.
    this.ctx.pointer.pointerDown(x, y, pointerId, performance.now())
    this.ctx.goTo(new CastingState(this.ctx))
  }

  exit(): void {
    // Persistent request stays alive across the cast cycle so the player
    // can keep checking what they're supposed to catch.
  }
}
