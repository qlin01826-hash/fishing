import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { pickCommissionFish } from '../data/FishCatalog'
import type { TapJudgement } from '../ui/PullPanel'
import { SinkingState } from './SinkingState'

/** Downbeats before the cast-hook window opens. */
const WAVES_BEFORE_CAST = 4
const DEVIATION_FAIL = 1
/** Beats the cast window stays open once it appears. */
const CAST_WINDOW_BEATS = 2

/**
 * Idle sailing — wave-breaking rhythm, then periodic cast windows.
 * Loops continuously: break waves → cast → lure → battle → catch → repeat.
 */
export class SailingState implements IFishingState {
  readonly id: FishingStateId = 'sailing'
  private readonly ctx: FishingContext

  private downbeatsSinceCast = 0
  private castWindowOpen = false
  private castBeatsLeft = 0
  private prevBeatPhase = 0.5
  private failurePlaying = false

  private readonly pullListener: (
    j: TapJudgement,
    nowMs: number,
    beatPhase: number,
  ) => void

  constructor(ctx: FishingContext) {
    this.ctx = ctx
    this.pullListener = (j, now, beatPhase) => this.onWaveJudgement(j, now, beatPhase)
  }

  enter(): void {
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.castPreview.hide()
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.hide()
    this.ctx.noteLane.container.visible = false
    this.ctx.noteLane.stop()

    this.downbeatsSinceCast = 0
    this.castWindowOpen = false
    this.castBeatsLeft = 0
    this.failurePlaying = false
    this.prevBeatPhase = this.ctx.beatClock.started ? this.ctx.beatClock.phase() : 0.5
    this.ctx.boat.resetDeviation()

    this.ctx.pullPanel.reset()
    this.ctx.pullPanel.setMode('wave')
    this.ctx.pullPanel.setWaveProgress(0, WAVES_BEFORE_CAST)
    this.ctx.pullPanel.container.visible = true
    this.ctx.pullPanel.onJudgement = this.pullListener

    this.ctx.commissionFish = pickCommissionFish(
      this.ctx.hungerSystem.getHunger(),
      Math.random,
      this.ctx.progression.stage.zone,
    )
    this.ctx.penguin.showRequest(this.ctx.commissionFish)

    if (this.ctx.progression.consumeZoneUp()) {
      const zoneName = t(`stage.${this.ctx.progression.stage.name}`)
      this.ctx.penguin.showMessage(t('game.enterStage', { name: zoneName }), 'excited', 2600)
      this.ctx.shake(5, 0.4)
    } else {
      this.ctx.progression.consumeStageUp()
    }
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    if (this.failurePlaying) {
      this.ctx.pullPanel.update(dtSeconds, performance.now())
      return
    }

    const hunger = this.ctx.hungerSystem.getHunger()
    if (hunger > 0.85) this.ctx.penguin.setMood('weak')
    else if (hunger > 0.6) this.ctx.penguin.setMood('sad')
    else if (hunger > 0.3) this.ctx.penguin.setMood('neutral')
    else this.ctx.penguin.setMood('request')

    const clock = this.ctx.beatClock
    const phase = clock.started ? clock.phase() : 0.5
    const isDownbeat =
      (this.prevBeatPhase > 0.6 && phase < 0.4) || phase < this.prevBeatPhase - 0.5
    if (isDownbeat) {
      this.onDownbeat()
    }
    this.prevBeatPhase = phase

    if (!this.castWindowOpen) {
      this.ctx.pullPanel.setWaveProgress(this.downbeatsSinceCast, WAVES_BEFORE_CAST)
    }
    this.ctx.pullPanel.update(dtSeconds, performance.now())

    if (this.ctx.boat.getDeviation() >= DEVIATION_FAIL || this.ctx.boat.getWaveSubmerge() >= 0.92) {
      this.triggerOverboardFailure()
    }
  }

  onPointerDown(_x: number, _y: number, _pointerId: number): void {}

  onPointerMove(_x: number, _y: number, _pointerId: number): void {}

  onPointerUp(_x: number, _y: number, _pointerId: number): void {}

  exit(): void {
    this.ctx.castPreview.hide()
    this.ctx.pullPanel.container.visible = false
    if (this.ctx.pullPanel.onJudgement === this.pullListener) {
      this.ctx.pullPanel.onJudgement = () => {}
    }
  }

  private onDownbeat(): void {
    if (this.failurePlaying) return

    if (this.castWindowOpen) {
      this.castBeatsLeft -= 1
      if (this.castBeatsLeft <= 0) {
        this.closeCastWindow()
      }
      return
    }

    this.downbeatsSinceCast = Math.min(WAVES_BEFORE_CAST, this.downbeatsSinceCast + 1)
    if (this.downbeatsSinceCast >= WAVES_BEFORE_CAST) {
      this.castWindowOpen = true
      this.castBeatsLeft = CAST_WINDOW_BEATS
      this.ctx.pullPanel.setMode('cast')
      this.ctx.penguin.showMessage(t('game.castHookHint'), 'excited', CAST_WINDOW_BEATS * 900)
    }
  }

  private closeCastWindow(): void {
    this.castWindowOpen = false
    this.castBeatsLeft = 0
    this.downbeatsSinceCast = 0
    this.ctx.pullPanel.setMode('wave')
    this.ctx.pullPanel.setWaveProgress(0, WAVES_BEFORE_CAST)
  }

  private onWaveJudgement(judgement: TapJudgement, nowMs: number, beatPhase: number): void {
    if (this.failurePlaying) return

    if (this.castWindowOpen && this.ctx.pullPanel.getMode() === 'cast') {
      this.performCast(nowMs)
      return
    }

    if (this.castWindowOpen) return

    this.ctx.boat.applyRhythmJudgement(judgement, beatPhase)
    if (judgement === 'perfect' || judgement === 'good') {
      this.ctx.ocean.triggerWaveBreak(judgement === 'perfect' ? 1 : 0.65)
      this.ctx.ocean.triggerCrestBurst(this.ctx.boat.deckCenterX)
      if (judgement === 'perfect') {
        this.ctx.shake(3, 0.18)
      }
    } else {
      this.ctx.shake(6, 0.28)
      this.ctx.penguin.showMessage(t('game.waveMiss'), 'worried', 800)
    }
  }

  private performCast(nowMs: number): void {
    const clock = this.ctx.beatClock
    const beatMs = Math.max(1, clock.beatIntervalSec * 1000)
    const offMs = clock.started ? Math.abs(clock.msFromNearestBeat(nowMs)) : beatMs * 0.5
    const off = Math.min(1, offMs / (beatMs * 0.5))
    const accuracy = 1 - off
    const power = 0.5 + accuracy * 0.5

    const { width, waterLineY, maxDepth } = this.ctx.viewport
    const speedMax = Math.min(820, Math.max(260, width * 0.4))
    const speed = 220 + power * (speedMax - 220)
    const ux = 0.5
    const uy = -0.86
    const targetDepthY = waterLineY + maxDepth * power

    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.castPreview.hide()
    this.ctx.pullPanel.container.visible = false
    this.ctx.audio.playCast(power)

    if (off < 0.18) {
      this.ctx.penguin.showMessage(t('game.castPerfect'), 'excited', 1100)
      this.ctx.shake(4, 0.22)
    } else if (off < 0.45) {
      this.ctx.penguin.showMessage(t('game.castGood'), 'happy', 1000)
    }

    this.closeCastWindow()
    this.ctx.hook.launch(ux * speed, uy * speed, targetDepthY)
    this.ctx.goTo(new SinkingState(this.ctx))
  }

  private triggerOverboardFailure(): void {
    if (this.failurePlaying) return
    this.failurePlaying = true
    this.ctx.pullPanel.container.visible = false
    this.ctx.audio.playFail()
    this.ctx.shake(10, 0.55)
    this.ctx.penguin.triggerOverboardFailure(() => {
      this.ctx.boat.resetDeviation()
      this.ctx.penguin.returnToBoat()
      this.ctx.penguin.showMessage(t('game.overboardFail'), 'sad', 3200)
      this.failurePlaying = false
      this.closeCastWindow()
      this.ctx.pullPanel.container.visible = true
      this.ctx.progression.reportSnap()
    })
  }
}
