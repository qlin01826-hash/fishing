import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId, FishDef } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import { pickFishForBite } from '../data/FishCatalog'
import { HookedState } from './HookedState'
import { SailingState } from './SailingState'

/**
 * Hook is hovering at depth. The player taps REEL to twitch the line —
 * each twitch raises the chance a nearby fish becomes interested.
 *
 * Once we cross a probabilistic threshold, we pick a biter from the
 * school (or spawn one nearby) and transition to `HookedState`. The
 * player can also FAST REEL to abort and re-cast.
 */
export class WaitingState implements IFishingState {
  readonly id: FishingStateId = 'waiting'
  private readonly ctx: FishingContext

  /** 0..1 accumulator: rises with twitches + time, reaches 1 → bite. */
  private biteCharge = 0
  private timeWaited = 0
  private autoUnsubscribe: (() => void) | null = null

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.biteCharge = 0
    this.timeWaited = 0
    this.ctx.reelButtons.setVisible(true)
    // Show the gameplay hint only if the penguin isn't already saying
    // something (e.g. "fish got away" feedback from HookedState.fail()).
    if (!this.ctx.penguin.isShowingTransientMessage()) {
      this.ctx.penguin.showMessage(t('game.waitingHint'), 'neutral', 2400)
    }
    const reelHandler = () => this.handleReel()
    const fastHandler = () => this.handleFastReel()
    this.ctx.reelButtons.onReel = reelHandler
    this.ctx.reelButtons.onFastReel = fastHandler
    this.autoUnsubscribe = () => {
      if (this.ctx.reelButtons.onReel === reelHandler) this.ctx.reelButtons.onReel = null
      if (this.ctx.reelButtons.onFastReel === fastHandler) this.ctx.reelButtons.onFastReel = null
    }
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    // Passive interest grows slowly even without reel taps so the player
    // isn't punished for letting the line sit a few seconds.
    this.timeWaited += dtSeconds
    this.biteCharge = Math.min(1, this.biteCharge + dtSeconds * 0.06)

    // Random chance per second to commit to a bite, scaled by charge.
    const chance = this.biteCharge * dtSeconds * 0.6
    if (this.timeWaited > 1 && Math.random() < chance) {
      this.commitBite()
    }
  }

  exit(): void {
    this.autoUnsubscribe?.()
    this.autoUnsubscribe = null
  }

  private handleReel(): void {
    this.ctx.audio.playReelClick()
    this.ctx.hook.twitchUp(14)
    this.biteCharge = Math.min(1, this.biteCharge + 0.12)
  }

  private handleFastReel(): void {
    // Yank the hook out, return to sailing
    this.ctx.audio.playReelClick()
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.goTo(new SailingState(this.ctx))
  }

  private commitBite(): void {
    const { fishSchool, hook, viewport, weatherSystem, progression } = this.ctx
    const depth01 =
      (hook.y - viewport.waterLineY) / Math.max(1, viewport.maxDepth)
    const nearby = fishSchool.pickNearestFish(hook.x, hook.y, 240)
    // Deeper stages have a rising chance to IGNORE whatever easy fish
    // happens to be drifting by and instead summon a stage-appropriate
    // (rarer, tougher) biter — so progression is felt in the catch, not
    // just in the battle tuning.
    const stageIndex = progression.index
    const wantHarder = Math.random() < Math.min(0.7, stageIndex * 0.2)
    const ambient: { fish: AmbientFish; def: FishDef } =
      nearby && !wantHarder
        ? nearby
        : fishSchool.spawnNear(
            hook.x,
            hook.y,
            pickFishForBite(
              weatherSystem.get(),
              depth01,
              Math.random,
              stageIndex * 0.15,
            ),
          )
    this.ctx.activeBiter = { def: ambient.def }
    this.ctx.audio.playBiteAlert()
    this.ctx.goTo(new HookedState(this.ctx), { ambient })
  }
}
