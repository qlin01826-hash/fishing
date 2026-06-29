import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import { BattleState } from './BattleState'
import { SailingState } from './SailingState'

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
    this.ctx.eventOverlay.hide()
    this.ctx.hook.setLineCue({ kind: 'strike', urgency: 0 })
    this.ctx.audio.playBiteAlert()
    // Penguin reaction: wide-eyed surprise the instant the bite hits.
    // The transient mood is restored to whatever SailingState picks on
    // the way back, so we just slam it here without bookkeeping.
    this.ctx.penguin.setMood('surprised')
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
    this.ctx.hook.setLineCue({ kind: 'strike', urgency: ratio })

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
    this.ctx.hook.clearLineCue()
    this.ctx.eventOverlay.hide()
  }

  private succeed(): void {
    this.ctx.audio.playHookset()
    this.ctx.goTo(new BattleState(this.ctx), { ambient: this.ambient })
  }

  private fail(): void {
    this.ctx.audio.playFail()
    this.ctx.penguin.showMessage(t('game.missedHint'), 'sad', 1800)
    if (this.ambient) {
      this.ctx.fishSchool.remove(this.ambient)
    }
    this.ctx.activeBiter = null
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.goTo(new SailingState(this.ctx))
  }
}
