import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishDef, FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import { SailingState } from './SailingState'

interface CatchPayload {
  def?: FishDef
}

/**
 * Result phase. Shows the catch banner, applies score & hunger relief,
 * then bounces back into SailingState (which rolls the next commission).
 */
export class CatchState implements IFishingState {
  readonly id: FishingStateId = 'catch'
  private readonly ctx: FishingContext
  private def: FishDef | null = null
  private finished = false

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(payload?: unknown): void {
    const p = payload as CatchPayload | undefined
    this.def = p?.def ?? this.ctx.activeBiter?.def ?? null
    if (!this.def) {
      this.ctx.goTo(new SailingState(this.ctx))
      return
    }

    const weather = this.ctx.weatherSystem.get()
    const score = Math.round(this.def.baseScore * weather.rewardMultiplier)

    const commissionFulfilled =
      this.ctx.commissionFish !== null && this.ctx.commissionFish.id === this.def.id
    const reliefBase = FISHING_CONSTANTS.reliefBase
    const relief = commissionFulfilled
      ? reliefBase * weather.rewardMultiplier
      : reliefBase * 0.3
    const bonus = commissionFulfilled
      ? t('game.bonusCaught', { relief: String(Math.round(relief * 100)) })
      : t('game.missCommission')

    // Apply hunger & score
    this.ctx.hungerSystem.feed(relief)
    this.ctx.addScore(score)
    this.ctx.hungerSystem.reportScore(this.ctx.sessionScore)
    // Count this successful catch — drives where the next battle's
    // song starts (a more advanced section / more complex arrangement).
    this.ctx.catchesThisRun += 1

    this.ctx.catchBanner.show(
      this.ctx.viewport.width,
      this.ctx.viewport.height,
      this.def,
      score,
      bonus,
    )
    // Wipe the old commission off the persistent channel before showing
    // the cheer — SailingState will refill it with the next request.
    this.ctx.penguin.hideBubble()
    this.ctx.penguin.showMessage(
      commissionFulfilled ? t('penguin.happy') : t('penguin.neutral'),
      commissionFulfilled ? 'happy' : 'neutral',
      2200,
    )
    this.ctx.commissionFish = null
    this.ctx.activeBiter = null
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    const done = this.ctx.catchBanner.update(dtSeconds)
    if (done && !this.finished) {
      this.finished = true
      this.ctx.goTo(new SailingState(this.ctx))
    }
  }

  exit(): void {
    this.ctx.catchBanner.hide()
  }
}
