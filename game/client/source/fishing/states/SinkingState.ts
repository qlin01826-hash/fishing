import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { WaitingState } from './WaitingState'

/**
 * Hook physics phase — splash, water drag, settle.
 *
 * The math lives on `Hook` itself; this state just listens for the
 * splash event (mode == 'water') the frame it happens to play audio,
 * and transitions to `WaitingState` once the hook reaches `hover`.
 */
export class SinkingState implements IFishingState {
  readonly id: FishingStateId = 'sinking'
  private readonly ctx: FishingContext
  private splashed = false

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.splashed = false
    this.ctx.eventOverlay.hide()
    this.ctx.reelButtons.setVisible(false)
    // Don't call penguin.hideBubble() here — it would wipe the persistent
    // commission request. Transient cast hint expires on its own timer.
  }

  update(_dtSeconds: number, _elapsedMs: number): void {
    const mode = this.ctx.hook.getMode()
    if (!this.splashed && (mode === 'water' || mode === 'hover')) {
      this.ctx.audio.playSplash()
      this.splashed = true
    }
    if (mode === 'hover') {
      this.ctx.goTo(new WaitingState(this.ctx))
    }
  }

  exit(): void {
    // nothing — visual elements (splash ring, bubbles) live on the hook
  }
}
