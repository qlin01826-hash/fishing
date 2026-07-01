import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishDef, FishingStateId, FishSize, KeeperTier } from '../types'
import { FISHING_CONSTANTS } from '../types'
import { SailingState } from './SailingState'

interface CatchPayload {
  def?: FishDef
  /** Weighted rhythm hit-rate (0..1) from the fight — >=0.85 = perfect capture. */
  accuracy?: number
  /** The fight rolled a Boss chart variant. */
  isBoss?: boolean
  /** Localized sea-zone name captured when the hook dropped. */
  zoneName?: string
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
    // Broadcast the catch as a single fact. Cross-system reactions —
    // advancing the difficulty ladder, ratcheting the music bed, and any
    // future achievements/combos — are wired up in FishingScene as
    // subscribers, so this state never has to know about them. (Crossing
    // into a new named zone gets announced by SailingState on the way
    // back out, which polls consumeZoneUp().)
    this.ctx.events.emit('fishCaught', {
      def: this.def,
      score,
      commissionFulfilled,
    })

    // File the trophy into the persistent Livewell. A high-accuracy fight on a
    // Boss chart lands the zone's apex specimen (Boss tier + a heftier weight);
    // otherwise the species keeps its own rarity. This never resets — it
    // accumulates across the whole infinite fishing loop.
    const isBoss = p?.isBoss ?? false
    const perfect = (p?.accuracy ?? 1) >= 0.85
    const tier: KeeperTier = isBoss ? 'boss' : this.def.rarity
    this.ctx.livewell.add({
      species: t(`fish.${this.def.i18nKey}`),
      tier,
      weight: rollWeight(this.def.size, isBoss, perfect),
      zone: p?.zoneName ?? t(`stage.${this.ctx.progression.stage.name}`),
    })

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

/** Roll a plausible physical weight from the size tier (Boss + perfect swell it). */
function rollWeight(size: FishSize, isBoss: boolean, perfect: boolean): string {
  const ranges: Record<FishSize, [number, number]> = {
    tiny: [0.1, 0.8],
    small: [0.8, 3],
    medium: [3, 9],
    large: [9, 25],
    huge: [25, 70],
  }
  const [lo, hi] = ranges[size]
  let kg = lo + Math.random() * (hi - lo)
  if (isBoss) kg *= 1.8 + Math.random() * 0.7
  if (perfect) kg *= 1.08
  return `${kg.toFixed(1)}kg`
}
