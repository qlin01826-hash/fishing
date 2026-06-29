import { t } from '@minigame/i18n'

import type { IFishingState } from '../StateMachine'

import type { FishingContext } from '../FishingContext'

import type { FishingStateId, FishDef } from '../types'

import type { AmbientFish } from '../entities/FishSchool'

import type { LureDirection } from '../ui/LurePads'

import type { TapJudgement } from '../ui/PullPanel'

import { pickFishForBite } from '../data/FishCatalog'

import { BattleState } from './BattleState'

import { SailingState } from './SailingState'



/** Successful on-beat dual swipes needed to hook a fish. */

const ROUNDS_TO_BITE = 5

const MAX_FAILS = 4

/** Downbeats after enter before the first preview. */

const INTRO_DOWNBEATS = 2



type LureRoundPhase = 'intro' | 'preview' | 'hit' | 'idle'



/**

 * Hook hovering at depth — each attempt is two beats:

 *   1. PREVIEW — direction + shrinking ring (full beat of lead time)

 *   2. HIT — dual swipe on the downbeat

 */

export class WaitingState implements IFishingState {

  readonly id: FishingStateId = 'waiting'

  private readonly ctx: FishingContext



  private lureProgress = 0

  private successCount = 0

  private failCount = 0

  private roundIndex = 0

  private commandDir: LureDirection = 'left'

  private finished = false

  private targetDef: FishDef | null = null

  private leadFish: AmbientFish | null = null



  private phase: LureRoundPhase = 'intro'

  private roundOpen = false

  private awaitingNextRound = false

  private introBeatsLeft = INTRO_DOWNBEATS

  private prevBeatPhase = 0.5

  private fallbackBeatTimer = 0



  private readonly swipeListener: (judgement: TapJudgement, dirOk: boolean) => void



  constructor(ctx: FishingContext) {

    this.ctx = ctx

    this.swipeListener = (judgement, dirOk) => this.onDualSwipe(judgement, dirOk)

  }



  enter(): void {

    this.lureProgress = 0

    this.successCount = 0

    this.failCount = 0

    this.roundIndex = 0

    this.commandDir = Math.random() < 0.5 ? 'left' : 'right'

    this.finished = false

    this.leadFish = null

    this.phase = 'intro'

    this.roundOpen = false

    this.awaitingNextRound = false

    this.introBeatsLeft = INTRO_DOWNBEATS

    this.prevBeatPhase = this.ctx.beatClock.started ? this.ctx.beatClock.phase() : 0.5

    this.fallbackBeatTimer = 0



    this.ctx.pullPanel.container.visible = false

    this.ctx.reelButtons.setVisible(false)

    this.ctx.eventOverlay.hide()

    this.ctx.hook.setMode('hover')

    this.ctx.hook.clearLineCue()



    const { hook, viewport, weatherSystem, progression, commissionFish } = this.ctx

    const depth01 = (hook.y - viewport.waterLineY) / Math.max(1, viewport.maxDepth)

    this.targetDef =

      commissionFish ??

      pickFishForBite(

        weatherSystem.get(),

        depth01,

        Math.random,

        progression.index * 0.15,

        progression.stage.zone,

      )



    this.ctx.lurePads.reset()

    this.ctx.lurePads.setVisible(true)

    this.ctx.lurePads.setProgress(0, ROUNDS_TO_BITE)

    this.ctx.lurePads.onDualSwipe = this.swipeListener



    this.ctx.penguin.setCommanderMode(true, this.commandDir)

    this.ctx.penguin.showMessage(t('game.lureCommandIntro'), 'request', 2800)

    this.ctx.audio.playLureCall(0)



    this.syncFishSchool()

  }



  update(dtSeconds: number, _elapsedMs: number): void {

    if (this.finished) return
    if (this.ctx.gameState.isTransitioning()) return



    this.ctx.lurePads.update(dtSeconds, performance.now())



    const clock = this.ctx.beatClock

    if (clock.started) {

      const phase = clock.phase()

      const isDownbeat =

        (this.prevBeatPhase > 0.6 && phase < 0.4) || phase < this.prevBeatPhase - 0.5

      if (isDownbeat) this.onDownbeat()

      this.prevBeatPhase = phase

    } else {

      this.tickFallbackBeat(dtSeconds)

    }



    this.syncFishSchool()

    this.ctx.hook.fightOffsetX = Math.sin(performance.now() * 0.004) * (8 + this.lureProgress * 12) * 0.3

    this.ctx.hook.fightOffsetY = Math.sin(performance.now() * 0.005) * 2

  }



  exit(): void {

    this.ctx.lurePads.setVisible(false)

    if (this.ctx.lurePads.onDualSwipe === this.swipeListener) {

      this.ctx.lurePads.onDualSwipe = () => {}

    }

    this.ctx.penguin.setCommanderMode(false)

    this.ctx.fishSchool.setLureGather(0, 0, 0, false)

    this.ctx.hook.fightOffsetX = 0

    this.ctx.hook.fightOffsetY = 0

  }



  private tickFallbackBeat(dtSeconds: number): void {

    this.fallbackBeatTimer += dtSeconds

    const beatSec = this.ctx.beatClock.beatIntervalSec || 60 / 92

    if (this.fallbackBeatTimer < beatSec) return

    this.fallbackBeatTimer = 0

    this.onDownbeat()

  }



  private onDownbeat(): void {

    if (this.finished) return



    if (this.phase === 'intro') {

      this.introBeatsLeft -= 1

      if (this.introBeatsLeft <= 0) {

        this.armPreview()

      }

      return

    }



    if (this.awaitingNextRound) {

      this.awaitingNextRound = false

      this.armPreview()

      return

    }



    if (this.phase === 'hit' && this.roundOpen) {

      this.closeRound(false)

      return

    }



    if (this.phase === 'preview') {

      this.beginHitWindow()

    }

  }



  /** Full beat of wind-up: show direction + shrinking telegraph ring. */

  private armPreview(): void {

    this.roundIndex += 1

    if (this.roundIndex > 1) {

      this.commandDir = this.commandDir === 'left' ? 'right' : 'left'

    }



    this.phase = 'preview'

    this.roundOpen = false

    this.ctx.lurePads.setCommandDirection(this.commandDir)

    this.ctx.lurePads.setProgress(this.successCount, ROUNDS_TO_BITE)

    this.ctx.lurePads.setPadPhase('preview')

    this.ctx.penguin.setCommanderMode(true, this.commandDir)



    const dirLabel =

      this.commandDir === 'left' ? t('game.directionLeft') : t('game.directionRight')

    this.ctx.penguin.showMessage(t('game.lurePreview', { dir: dirLabel }), 'request', 1200)

  }



  /** Downbeat after preview — open the hit window for this beat. */

  private beginHitWindow(): void {

    this.phase = 'hit'

    this.roundOpen = true

    this.ctx.lurePads.setListenActive(true)

    this.ctx.audio.playLureCall(this.roundIndex % 5)

    this.ctx.penguin.showMessage(t('game.lureNow'), 'excited', 500)

  }



  private onDualSwipe(judgement: TapJudgement, dirOk: boolean): void {

    if (this.finished || !this.roundOpen || this.phase !== 'hit') return

    const ok = dirOk && judgement !== 'miss'

    this.closeRound(ok, judgement)

  }



  private closeRound(success: boolean, judgement: TapJudgement = 'miss'): void {

    if (!this.roundOpen && !success) return

    this.roundOpen = false

    this.phase = 'idle'

    this.ctx.lurePads.closeRound()



    if (success) {

      this.successCount += 1

      this.lureProgress = Math.min(1, this.lureProgress + 1 / ROUNDS_TO_BITE)

      this.ctx.audio.playLureEcho(this.successCount % 5, judgement === 'perfect')

      this.ctx.shake(3, 0.12)

      this.spawnGatherFish()

      if (this.successCount >= ROUNDS_TO_BITE || this.lureProgress >= 1) {

        this.finishLure(true)

        return

      }

    } else {

      this.failCount += 1

      this.lureProgress = Math.max(0, this.lureProgress - 0.08)

      this.ctx.audio.playFail()

      this.ctx.shake(5, 0.18)

      this.ctx.penguin.showMessage(t('game.lureMiss'), 'worried', 700)

      if (this.failCount >= MAX_FAILS) {

        this.finishLure(false)

        return

      }

    }



    if (!this.finished) {

      this.awaitingNextRound = true

    }

  }



  private spawnGatherFish(): void {

    if (!this.targetDef) return

    const { hook, fishSchool } = this.ctx

    const count = this.successCount === 1 ? 2 : 1

    fishSchool.spawnLureFish(hook.x, hook.y, this.targetDef, count)

    if (!this.leadFish) {

      const near = fishSchool.pickNearestFish(hook.x, hook.y, 160)

      if (near) this.leadFish = near.fish

    }

  }



  private syncFishSchool(): void {

    const { hook, fishSchool } = this.ctx

    const danceDir: 1 | -1 = this.commandDir === 'left' ? -1 : 1

    fishSchool.setLureGather(this.lureProgress, hook.x, hook.y, true, danceDir)

  }



  private finishLure(passed: boolean): void {

    if (this.finished) return

    this.finished = true

    this.roundOpen = false

    this.ctx.lurePads.closeRound()



    if (passed) {

      this.ctx.penguin.showMessage(t('game.lureHooked'), 'excited', 1400)

      this.commitBite(true)

    } else {

      this.ctx.penguin.showMessage(t('game.lureFail'), 'sad', 2000)

      this.ctx.audio.playFail()

      this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)

      this.ctx.goTo(new SailingState(this.ctx))

    }

  }



  private commitBite(withSuccessSfx = false): void {

    if (withSuccessSfx) this.ctx.audio.playLureSuccess()

    const { fishSchool, hook, viewport, weatherSystem, progression } = this.ctx

    const depth01 = (hook.y - viewport.waterLineY) / Math.max(1, viewport.maxDepth)

    const stageIndex = progression.index

    const def =

      this.targetDef ??

      pickFishForBite(

        weatherSystem.get(),

        depth01,

        Math.random,

        stageIndex * 0.15,

        progression.stage.zone,

      )

    let ambient: { fish: AmbientFish; def: FishDef }

    if (this.leadFish) {

      ambient = { fish: this.leadFish, def }

    } else {

      const nearby = fishSchool.pickNearestFish(hook.x, hook.y, 200)

      ambient = nearby ?? fishSchool.spawnNear(hook.x, hook.y, def)

    }

    this.ctx.activeBiter = { def: ambient.def }

    this.ctx.audio.playBiteAlert()

    this.ctx.penguin.setCommanderMode(false)

    this.ctx.penguin.showMessage(t('game.battleIntro'), 'excited', 2200)

    this.ctx.lurePads.setVisible(false)

    const ambientFish = ambient.fish
    this.ctx.gameState.onFishHooked(() => {
      this.ctx.goTo(new BattleState(this.ctx), { ambient: ambientFish })
    })
  }
}


