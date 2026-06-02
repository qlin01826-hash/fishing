import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishDef, FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import { bedFloorForStage } from '../systems/AudioSystem'
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
    // Advance the difficulty ladder one stage (every catch = one stage,
    // 15 total). Crossing into a new named zone gets announced by
    // SailingState on the way back out (it polls consumeZoneUp()).
    this.ctx.progression.reportCatch()
    // Ratchet the continuous music bed UP a notch as the run deepens, so
    // the soundtrack keeps gaining instruments/layers and never thins
    // back out — the song grows monotonically richer the more you catch.
    this.ctx.audio.setSectionFloor(bedFloorForStage(this.ctx.progression.index))

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
    // Pick a richer reaction mood based on what we actually caught.
    // Legendary lands earn a love-eyes "♥" cheer, epic earns a proud
    // smug grin, ordinary commissioned catches stay happy, and
    // off-commission catches (player ignored the request) get a
    // dispassionate neutral.
    let cheerMood: 'love' | 'proud' | 'happy' | 'neutral'
    let cheerText: string
    if (commissionFulfilled && this.def.rarity === 'legendary') {
      cheerMood = 'love'
      cheerText = t('penguin.happy')
    } else if (commissionFulfilled && this.def.rarity === 'epic') {
      cheerMood = 'proud'
      cheerText = t('penguin.happy')
    } else if (commissionFulfilled) {
      cheerMood = 'happy'
      cheerText = t('penguin.happy')
    } else {
      cheerMood = 'neutral'
      cheerText = t('penguin.neutral')
    }
    this.ctx.penguin.showMessage(cheerText, cheerMood, 2200)
    // Catch-celebration jump. Height scales with fish size so the
    // penguin clearly *reacts* to a big haul: a tiny shrimp gets a
    // small hop, a huge sea creature launches the penguin off the
    // deck. The hooked surprise was the inhale — this is the payoff.
    const size = this.def.size
    let jumpHeight = 10
    if (size === 'large') jumpHeight = 26
    else if (size === 'huge') jumpHeight = 42
    else if (size === 'medium') jumpHeight = 16
    // Legendary lands get an extra springboard regardless of size so
    // the moment always feels climactic.
    if (this.def.rarity === 'legendary') jumpHeight += 10
    this.ctx.penguin.triggerJump(jumpHeight, 0.55)
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
