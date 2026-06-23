import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId, FishDef } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import { pickFishForBite } from '../data/FishCatalog'
import { HookedState } from './HookedState'
import { SailingState } from './SailingState'

/**
 * Hook is hovering at depth — the "luring" phase, reframed as a musical
 * CALL-AND-RESPONSE duet with the fish (the opening phrase of the
 * fishing performance):
 *
 *   1. CALL  — the game "sings" a short rhythmic motif (a pattern of
 *              hits over one 4-beat bar). Each hit flashes a beat pip and
 *              plays a pentatonic note.
 *   2. LISTEN — the player echoes it back by tapping REEL on those same
 *              beats. On-beat echoes charge the bite; a clean bar lands
 *              the fish.
 *
 * This is a zero-stakes, teach-by-playing on-ramp: the player learns to
 * feel the beat before any tension/willpower is on the line.
 *
 * Fallback: until the audio context is unlocked (no BeatClock), we keep
 * the original "tap REEL to twitch + passive interest" behaviour so the
 * line never gets stuck waiting for a clock that never started.
 */

/** One 4-beat bar. `true` = a hit the player must echo. */
const LURE_PATTERNS: ReadonlyArray<ReadonlyArray<boolean>> = [
  [true, false, true, false], // beats 1 & 3 — gentle half-note call
  [true, true, false, true], // 1, 2, & 4 — a little syncopation
  [true, false, true, true], // 1, 3, & 4 — push to the bar end
]

/** ms either side of a beat that still counts as an on-beat echo. */
const ECHO_WINDOW_MS = 170

export class WaitingState implements IFishingState {
  readonly id: FishingStateId = 'waiting'
  private readonly ctx: FishingContext

  /** 0..1 accumulator: rises with correct echoes (+ slow passive). */
  private biteCharge = 0
  private timeWaited = 0
  private autoUnsubscribe: (() => void) | null = null

  // ---- Call-and-response lure ----
  private lureActive = false
  private patternIndex = 0
  private pattern: ReadonlyArray<boolean> = LURE_PATTERNS[0]
  /** Beat index where the current round's CALL bar begins. */
  private roundStartBeat = 0
  /** Highest beat we've already emitted a call note for. */
  private lastCallBeat = -1
  private phase: 'call' | 'listen' = 'call'
  private echoes: Array<'none' | 'good' | 'miss'> = ['none', 'none', 'none', 'none']

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.biteCharge = 0
    this.timeWaited = 0
    this.ctx.reelButtons.setVisible(true)

    this.lureActive = this.ctx.beatClock.started
    if (this.lureActive) {
      this.ctx.eventOverlay.showLure()
      this.startRound()
    } else if (!this.ctx.penguin.isShowingTransientMessage()) {
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
    this.timeWaited += dtSeconds

    if (this.lureActive && this.ctx.beatClock.started) {
      this.updateLure()
    } else {
      // Fallback: original passive interest model.
      this.biteCharge = Math.min(1, this.biteCharge + dtSeconds * 0.06)
      const chance = this.biteCharge * dtSeconds * 0.6
      if (this.timeWaited > 1 && Math.random() < chance) {
        this.commitBite()
      }
      return
    }

    // A slow passive trickle so a totally silent player still eventually
    // gets a bite, but active echoing is far faster.
    this.biteCharge = Math.min(1, this.biteCharge + dtSeconds * 0.02)
    if (this.biteCharge >= 1 && this.timeWaited > 1) {
      this.commitBite()
    }
  }

  exit(): void {
    this.autoUnsubscribe?.()
    this.autoUnsubscribe = null
    this.ctx.eventOverlay.hide()
  }

  // ---- Lure round lifecycle ----

  private startRound(): void {
    this.pattern = LURE_PATTERNS[this.patternIndex % LURE_PATTERNS.length]
    this.patternIndex += 1
    // One-beat lead-in so the first call note never fires mid-beat.
    this.roundStartBeat = this.ctx.beatClock.nextBeatAfterPerf(performance.now()) + 1
    this.lastCallBeat = this.roundStartBeat - 1
    this.phase = 'call'
    this.echoes = ['none', 'none', 'none', 'none']
    this.pushOverlay(-1)
  }

  private updateLure(): void {
    const now = performance.now()
    const beat = this.ctx.beatClock.currentBeat(now)
    const callEnd = this.roundStartBeat + 4 // first listen beat
    const roundEnd = this.roundStartBeat + 8

    // Round finished — score it and start the next call.
    if (beat >= roundEnd) {
      this.finishRound()
      return
    }

    if (beat < callEnd) {
      // CALL phase: emit each hit's note once as we cross its beat.
      this.phase = 'call'
      while (this.lastCallBeat < beat && this.lastCallBeat + 1 < callEnd) {
        this.lastCallBeat += 1
        const idx = this.lastCallBeat - this.roundStartBeat
        if (idx >= 0 && idx < 4 && this.pattern[idx]) {
          this.ctx.audio.playLureCall(idx)
        }
      }
      const activeIdx = beat - this.roundStartBeat
      this.pushOverlay(activeIdx >= 0 && activeIdx < 4 ? activeIdx : -1)
    } else {
      // LISTEN phase: player echoes via REEL taps (handleReel).
      this.phase = 'listen'
      const activeIdx = beat - callEnd
      this.pushOverlay(activeIdx >= 0 && activeIdx < 4 ? activeIdx : -1)
    }
  }

  private finishRound(): void {
    const hits = this.pattern.filter(Boolean).length
    const good = this.echoes.filter((e) => e === 'good').length
    // A clean bar (every hit echoed on-beat) is a big reward and, if the
    // player has been consistent, lands the fish.
    if (hits > 0 && good >= hits) {
      this.biteCharge = Math.min(1, this.biteCharge + 0.34)
    }
    if (this.biteCharge >= 1 && this.timeWaited > 1) {
      this.commitBite()
      return
    }
    this.startRound()
  }

  private pushOverlay(activeBeat: number): void {
    const headline = this.phase === 'call' ? t('game.lureListen') : t('game.lureEcho')
    const color = this.phase === 'call' ? '#ffd166' : '#9fe6ff'
    this.ctx.eventOverlay.setLureState(
      this.pattern as boolean[],
      this.phase,
      activeBeat,
      this.echoes,
      headline,
      color,
    )
  }

  // ---- Input ----

  private handleReel(): void {
    this.ctx.hook.twitchUp(14)

    if (!this.lureActive || !this.ctx.beatClock.started || this.phase !== 'listen') {
      // Plain twitch (fallback, or during the call phase).
      this.ctx.audio.playReelClick()
      if (!this.lureActive) this.biteCharge = Math.min(1, this.biteCharge + 0.12)
      return
    }

    // Echo: match this tap to the nearest listen beat.
    const now = performance.now()
    const nearestBeat = this.ctx.beatClock.nearestBeatIndex(now)
    const idx = nearestBeat - (this.roundStartBeat + 4)
    if (idx < 0 || idx > 3) {
      this.ctx.audio.playReelClick()
      return
    }
    const offset = Math.abs(this.ctx.beatClock.msFromNearestBeat(now))
    const onBeat = offset <= ECHO_WINDOW_MS
    if (this.pattern[idx] && onBeat && this.echoes[idx] !== 'good') {
      this.echoes[idx] = 'good'
      this.ctx.audio.playLureEcho(idx, true)
      this.biteCharge = Math.min(1, this.biteCharge + 0.16)
    } else {
      if (this.echoes[idx] === 'none') this.echoes[idx] = 'miss'
      this.ctx.audio.playLureEcho(idx, false)
    }
  }

  private handleFastReel(): void {
    this.ctx.audio.playReelClick()
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.goTo(new SailingState(this.ctx))
  }

  private commitBite(): void {
    const { fishSchool, hook, viewport, weatherSystem, progression } = this.ctx
    if (this.lureActive) this.ctx.audio.playLureSuccess()
    const depth01 = (hook.y - viewport.waterLineY) / Math.max(1, viewport.maxDepth)
    const nearby = fishSchool.pickNearestFish(hook.x, hook.y, 240)
    const stageIndex = progression.index
    const wantHarder = Math.random() < Math.min(0.7, stageIndex * 0.2)
    const ambient: { fish: AmbientFish; def: FishDef } =
      nearby && !wantHarder
        ? nearby
        : fishSchool.spawnNear(
            hook.x,
            hook.y,
            pickFishForBite(weatherSystem.get(), depth01, Math.random, stageIndex * 0.15),
          )
    this.ctx.activeBiter = { def: ambient.def }
    this.ctx.audio.playBiteAlert()
    this.ctx.goTo(new HookedState(this.ctx), { ambient })
  }
}
