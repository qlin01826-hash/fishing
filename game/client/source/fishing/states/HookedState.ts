import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import { BattleState } from './BattleState'
import { WaitingState } from './WaitingState'

interface HookedPayload {
  ambient?: { fish: AmbientFish; def: unknown } | null
}

/**
 * Reaction-window phase. The bobber wiggles and "! !! !!!" intensifies.
 * The player gets `strike_window_ms` to perform an upward swipe.
 *
 * Implementation detail: the swipe is evaluated on pointer release
 * (`onPointerUp`). If the user just taps, we ignore — only true swipes
 * count, so we don't accidentally consume background taps.
 */
export class HookedState implements IFishingState {
  readonly id: FishingStateId = 'hooked'
  private readonly ctx: FishingContext
  private elapsedMs = 0
  private ambient: AmbientFish | null = null

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(payload?: unknown): void {
    const p = payload as HookedPayload | undefined
    this.ambient =
      p && p.ambient && typeof p.ambient === 'object' && 'fish' in p.ambient
        ? ((p.ambient as { fish: AmbientFish }).fish ?? null)
        : null
    this.elapsedMs = 0
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.showStrike()
    this.ctx.audio.playBiteAlert()
    // Keep the commission request bubble — players need it as a reminder
    // during the strike window. The eventOverlay handles the strike prompt.
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    this.elapsedMs += dtSeconds * 1000

    // Bobber wiggle — pull the hook toward the biter so the line dances
    if (this.ambient) {
      const dx = this.ambient.x - this.ctx.hook.x
      const dy = this.ambient.y - this.ctx.hook.y
      this.ctx.hook.fightOffsetX = dx * 0.05
      this.ctx.hook.fightOffsetY = dy * 0.05
      this.ctx.hook.setMode('fight')
    }

    // Make the strike text bigger as time runs out (urgency)
    const ratio = Math.min(1, this.elapsedMs / FISHING_CONSTANTS.strike_window_ms)
    const exclam = ratio < 0.3 ? '!' : ratio < 0.6 ? '!!' : '!!!'
    // Replace the static prompt with rising tension (only when no swipe attempted yet)
    if (!this.ctx.pointer.active) {
      this.ctx.eventOverlay.showMessage(t('game.biteHint') + ' ' + exclam, '#ffd166')
    }

    if (this.elapsedMs > FISHING_CONSTANTS.strike_window_ms) {
      this.fail()
    }
  }

  onPointerDown(x: number, y: number, pointerId: number): void {
    this.ctx.pointer.pointerDown(x, y, pointerId, performance.now())
  }

  onPointerMove(x: number, y: number, pointerId: number): void {
    this.ctx.pointer.pointerMove(x, y, pointerId, performance.now())
  }

  onPointerUp(_x: number, _y: number, pointerId: number): void {
    const now = performance.now()
    const speed = this.ctx.pointer.instantSpeed(now)
    const { dx, dy } = this.ctx.pointer.totalDelta()
    this.ctx.pointer.pointerUp(pointerId)
    const upward = dy < -28 && Math.abs(dy) > Math.abs(dx) * 0.6
    if (upward && (speed > 200 || Math.abs(dy) > 80)) {
      this.succeed()
    } else if (Math.hypot(dx, dy) > 28) {
      // Wrong direction swipe = fish escapes
      this.fail()
    }
    // A plain tap is ignored — let the timer run out naturally.
  }

  exit(): void {
    this.ctx.eventOverlay.hide()
  }

  private succeed(): void {
    this.ctx.audio.playHookset()
    this.ctx.goTo(new BattleState(this.ctx), { ambient: this.ambient })
  }

  private fail(): void {
    this.ctx.audio.playFail()
    // Use the penguin bubble (which persists across state transitions
    // unlike the event overlay that hides on exit()) so the player
    // actually gets to read the "fish got away" feedback.
    this.ctx.penguin.showMessage(t('game.missedHint'), 'sad', 1800)
    if (this.ambient) {
      this.ctx.fishSchool.remove(this.ambient)
    }
    this.ctx.activeBiter = null
    this.ctx.hook.setMode('hover')
    this.ctx.goTo(new WaitingState(this.ctx))
  }
}
