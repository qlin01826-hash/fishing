import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { Direction, FishDef, FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import type { TapJudgement } from '../ui/PullPanel'
import { sectionForCatches } from '../systems/AudioSystem'
import { CatchState } from './CatchState'
import { SailingState } from './SailingState'

interface BattlePayload {
  ambient?: AmbientFish | null
}

/**
 * The fight phase — the core rhythm game.
 *
 * Two ORTHOGONAL judgement tracks, each with its own progress bar:
 *
 * 1. **Base beat (底拍)** — drives the TOP tension bar.
 *    - Notes scroll right→left on the {@link NoteLane}. The player taps
 *      the {@link PullPanel} as each note reaches the hit zone.
 *    - Perfect/Good taps nudge the white tracker toward the safe zone
 *      centre and reset the missed-beat counter.
 *    - Two consecutive auto-missed beats put the fish into a STRUGGLE
 *      state: the tracker drifts steadily AWAY from safe. Any successful
 *      tap pulls it back and ends the struggle.
 *    - Base-beat outcomes never modify the catch-success bar.
 *
 * 2. **Enhanced beats (加强拍)** — drive the RIGHT willpower bar.
 *    - "Follow fish" event: hold inside the moving yellow ring until
 *      its progress arc fills.
 *      Success → -big chunk of willpower (closer to catch).
 *      Failure → +small chunk of willpower (knocked back).
 *    - "Fish running" event: counter-swipe in the indicated direction.
 *      Same success/failure willpower swing.
 *    - Enhanced-beat outcomes never modify the tension tracker.
 *
 * 3. Background drain: while the tracker is inside the safe zone, the
 *    willpower bar slowly leaks down. So patient base-beat play wins
 *    eventually; perfect enhanced play wins fast.
 *
 * Pointer routing: PullPanel handles its own Pixi pointer events and
 * forwards every tap into BattleState via {@link onPullJudgement}.
 * Raw canvas pointer events from the scene flow into onPointer*; we
 * skip the ones inside the pull panel so the two input layers don't
 * fight.
 */
type EventKind = 'idle' | 'follow' | 'run'

export class BattleState implements IFishingState {
  readonly id: FishingStateId = 'battle'
  private readonly ctx: FishingContext
  private readonly def: FishDef

  // --- Layer 1: tension (base beat) ---
  private trackerT = 0.5
  /** Centre of the safe zone (0..1). Drifts slowly for visual interest. */
  private safeCenter = 0.5
  /** Half-width of safe zone (0..1). */
  private safeHalf = 0.18
  /** Time tracker has been outside safe zone (used for line-snap timer). */
  private outOfZoneMs = 0
  /** True while the fish is struggling (after 2 consecutive missed beats). */
  private struggling = false
  /** Direction the struggle is pushing the tracker (-1 or +1). Re-rolled when struggle starts. */
  private struggleDir = 1
  /** Saved binding to remove the pull-panel listener on exit. */
  private readonly pullListener: (j: TapJudgement, nowMs: number) => void

  // --- Layer 2: willpower (enhanced beats + background drain) ---
  private willpower: number
  private readonly initialWillpower: number

  // --- Fish entity ---
  private ambient: AmbientFish | null = null
  private fishTargetX = 0
  private fishTargetY = 0
  private fishTargetTimer = 0

  // --- Event scheduler ---
  private eventKind: EventKind = 'idle'
  private nextEventInMs = 7500
  private followLocksLeft: number
  private followLockProgress = 0
  private eventTimeMs = 0
  private eventWindowMs = 2200
  private runDirection: Direction = 'up'
  private runConsumed = false

  // --- Music intensity arc ---
  /**
   * Beats remaining before the next intensity decay step. Bumps reset
   * this to `intensityDecayBeats`. When it hits zero AND music intensity
   * is > 0, the soundtrack drops one layer and the timer reloads.
   *
   * 8 beats at 88..120 BPM is roughly 4–5 seconds — long enough that a
   * skilled player can stack consecutive enhanced beats and ride the
   * ramp all the way to L3, while a one-off lucky hit dies back down
   * before the next bar lands.
   */
  private decayBeatsLeft = 0
  private readonly intensityDecayBeats = 8
  /** Snapshot of last-seen beat index so we can drive decay per-beat in update(). */
  private lastSeenBeat = 0

  constructor(ctx: FishingContext) {
    this.ctx = ctx
    const biter = ctx.activeBiter
    if (!biter) throw new Error('BattleState entered without active biter')
    this.def = biter.def
    this.willpower = biter.def.willpower
    this.initialWillpower = biter.def.willpower
    this.followLocksLeft = biter.def.followLocks
    this.safeHalf = Math.max(0.07, 0.18 - this.def.strictness * 0.1)
    this.pullListener = (j, now) => this.onPullJudgement(j, now)
  }

  enter(payload?: unknown): void {
    const p = payload as BattlePayload | undefined
    this.ambient = p?.ambient ?? null
    if (this.ambient) {
      this.fishTargetX = this.ambient.x
      this.fishTargetY = this.ambient.y
      this.ambient.vx = 0
    }
    this.ctx.hook.setMode('fight')
    // Tension/willpower bar layout is owned by FishingScene.onResize so
    // that one place decides where HUD ends and bars begin.
    this.ctx.tensionBar.container.visible = true
    this.ctx.willpowerBar.container.visible = true
    this.ctx.pullPanel.container.visible = true
    this.ctx.noteLane.container.visible = true
    this.ctx.pullPanel.reset()
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.hide()

    // Music: tempo scales with hunger-driven weather intensity, and the
    // *starting section* of the song scales with how many fish the
    // player has caught this session — so the song becomes more
    // complex/intense the longer the run goes. Battle 1 opens at intro;
    // battle 4+ opens directly at chorus with key changes available.
    const intensity = this.ctx.weatherSystem.get().intensity
    const bpm = 88 + Math.round(intensity * 32) // 88..120
    this.ctx.beatClock.setBpm(bpm)
    const startSection = sectionForCatches(this.ctx.catchesThisRun)
    this.ctx.audio.startBeats(intensity, startSection)
    this.ctx.noteLane.start()
    // Mirror the audio's starting intensity into the note lane so the
    // initial chart density matches what the player will be hearing.
    this.ctx.noteLane.setIntensity(this.ctx.audio.getMusicIntensity())
    this.decayBeatsLeft = 0
    this.lastSeenBeat = this.ctx.beatClock.currentBeat()

    // PullPanel taps now flow through us so we can update tension state
    // (and forward the same judgement into the NoteLane).
    this.ctx.pullPanel.onJudgement = this.pullListener

    // First enhanced beat takes ~8s — gives the player the entire
    // intro (2 bars) and the first half of the verse to lock into the
    // rhythm before being asked to react to anything special.
    this.nextEventInMs = 7500
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    this.updateFish(dtSeconds)
    this.updateTension(dtSeconds)
    this.ctx.pullPanel.update(dtSeconds, performance.now())
    this.processNoteLaneOutcomes()
    this.updateWillpowerBackground(dtSeconds)
    this.updateEvents(dtSeconds)
    this.updateMusicIntensityDecay()
    this.updateUi()
    this.checkOutcomes()
  }

  // ---- pointer routing ----

  onPointerDown(x: number, y: number, pointerId: number): void {
    if (this.isInsidePullPanel(x, y)) return
    this.ctx.pointer.pointerDown(x, y, pointerId, performance.now())
  }

  onPointerMove(x: number, y: number, pointerId: number): void {
    if (this.isInsidePullPanel(x, y)) return
    this.ctx.pointer.pointerMove(x, y, pointerId, performance.now())
  }

  onPointerUp(_x: number, _y: number, pointerId: number): void {
    const now = performance.now()
    if (this.eventKind === 'run' && !this.runConsumed) {
      const { dx, dy } = this.ctx.pointer.totalDelta()
      const speed = this.ctx.pointer.instantSpeed(now)
      if (this.matchesRunCounter(dx, dy, speed)) {
        this.runConsumed = true
        this.endRunEvent(true)
      }
    }
    this.ctx.pointer.pointerUp(pointerId)
  }

  exit(): void {
    this.ctx.tensionBar.container.visible = false
    this.ctx.willpowerBar.container.visible = false
    this.ctx.pullPanel.container.visible = false
    this.ctx.noteLane.container.visible = false
    this.ctx.noteLane.stop()
    this.ctx.eventOverlay.hide()
    this.ctx.audio.stopBeats()
    this.ctx.pullPanel.setStruggling(false)
    // Tear down our binding so a stale battle instance can't keep
    // observing the (shared) PullPanel after we've exited.
    if (this.ctx.pullPanel.onJudgement === this.pullListener) {
      this.ctx.pullPanel.onJudgement = () => {}
    }
    if (this.ambient) {
      this.ctx.fishSchool.remove(this.ambient)
      this.ambient = null
    }
  }

  // ---- subsystem updates ----

  private updateFish(dtSeconds: number): void {
    if (!this.ambient) return
    this.fishTargetTimer -= dtSeconds
    if (this.fishTargetTimer <= 0) {
      // Struggling fish thrashes harder, run-event fish darts farther.
      const baseRange = this.eventKind === 'run' ? 220 : 90
      const range = this.struggling ? baseRange * 1.8 : baseRange
      this.fishTargetX = this.ambient.x + (Math.random() - 0.5) * range
      this.fishTargetY = this.ambient.y + (Math.random() - 0.5) * range * 0.4
      this.fishTargetTimer = this.struggling ? 0.25 + Math.random() * 0.35 : 0.6 + Math.random() * 0.8
    }
    // Spring follow with extra wiggle when struggling.
    const wiggle = this.struggling
      ? Math.sin(performance.now() * 0.025) * 6
      : 0
    const dx = (this.fishTargetX - this.ambient.x) * Math.min(1, dtSeconds * 3.5) + wiggle * dtSeconds
    const dy = (this.fishTargetY - this.ambient.y) * Math.min(1, dtSeconds * 3.5)
    this.ctx.fishSchool.moveFish(this.ambient, dx, dy)
    if (this.ctx.hook.getMode() === 'fight') {
      const dxh = (this.ambient.x - this.ctx.hook.x) * Math.min(1, dtSeconds * 4)
      const dyh = (this.ambient.y - this.ctx.hook.y) * Math.min(1, dtSeconds * 4)
      this.ctx.hook.fightOffsetX += dxh
      this.ctx.hook.fightOffsetY += dyh
    }
  }

  /**
   * Tension is now driven solely by the rhythm input. We keep a slow
   * sinusoidal drift on `safeCenter` for visual interest, but the
   * tracker only moves because of:
   *   - explicit nudges from {@link onPullJudgement} (immediate),
   *   - a gentle "press-to-pull" continuous nudge while the player holds,
   *   - the STRUGGLE drift when consecutive beats are missed.
   */
  private updateTension(dtSeconds: number): void {
    const tired = 1 - this.willpower / this.initialWillpower
    const targetCenter = 0.5 + Math.sin(performance.now() * 0.0006) * 0.22 * (1 - tired * 0.5)
    this.safeCenter += (targetCenter - this.safeCenter) * Math.min(1, dtSeconds * 0.6)

    if (this.struggling) {
      // Constant push away from safe centre, scaled by fight strength.
      this.trackerT += this.struggleDir * dtSeconds * 0.35 * this.def.fightStrength
    } else {
      // Holding the panel applies a gentle continuous pull toward safe
      // centre — a backup for players who can't keep rhythm.
      const press = this.ctx.pullPanel.pressPower
      const toCenter = this.safeCenter - this.trackerT
      this.trackerT += toCenter * press * dtSeconds * 0.9
      // Idle gravity: when neither pressing nor tapping, the tracker
      // slowly drifts off-centre so the player can't just walk away.
      if (press < 0.1) {
        this.trackerT += -Math.sign(toCenter) * dtSeconds * 0.04
      }
    }

    if (this.trackerT < 0) this.trackerT = 0
    if (this.trackerT > 1) this.trackerT = 1

    const inZone =
      this.trackerT >= this.safeCenter - this.safeHalf &&
      this.trackerT <= this.safeCenter + this.safeHalf
    if (inZone) {
      this.outOfZoneMs = Math.max(0, this.outOfZoneMs - dtSeconds * 1200)
    } else {
      this.outOfZoneMs += dtSeconds * 1000
    }
  }

  /** Called by PullPanel on every tap (via the listener wired in enter). */
  private onPullJudgement(judgement: TapJudgement, nowMs: number): void {
    // Forward to the lane so the closest note gets consumed (or not).
    this.ctx.noteLane.registerTap(judgement, nowMs)

    const toCenter = this.safeCenter - this.trackerT
    if (judgement === 'perfect') {
      this.trackerT += toCenter * 0.55
      // A correct tap always resets the missed-beat streak even if no
      // lane note happened to be in the window (lead-in beats, between
      // events, etc.) — playing in rhythm is what matters.
      this.ctx.noteLane.consecutiveAutoMisses = 0
      this.clearStruggle()
    } else if (judgement === 'good') {
      this.trackerT += toCenter * 0.28
      this.ctx.noteLane.consecutiveAutoMisses = 0
      this.clearStruggle()
    } else {
      // Explicit off-beat tap: tiny shove away, no struggle escalation
      // (auto-misses on missed BEATS are the canonical struggle trigger).
      this.trackerT -= Math.sign(toCenter) * 0.04
      this.ctx.shake(4, 0.12)
    }
  }

  /**
   * Pull-side bookkeeping for note auto-misses. Two in a row triggers
   * the struggle state until the next successful hit.
   */
  private processNoteLaneOutcomes(): void {
    if (!this.struggling && this.ctx.noteLane.consecutiveAutoMisses >= 2) {
      this.struggling = true
      this.struggleDir = Math.sign(this.trackerT - this.safeCenter) || (Math.random() < 0.5 ? -1 : 1)
      this.ctx.pullPanel.setStruggling(true)
      this.ctx.shake(8, 0.35)
      this.ctx.audio.playFail()
    }
  }

  private clearStruggle(): void {
    if (this.struggling) {
      this.struggling = false
      this.ctx.pullPanel.setStruggling(false)
      this.ctx.noteLane.consecutiveAutoMisses = 0
      this.ctx.audio.playKick()
    }
  }

  /**
   * Slow background willpower drain while the tracker is in the safe
   * zone. This is the "reeling in" baseline; enhanced beats add big
   * chunks on top.
   */
  private updateWillpowerBackground(dtSeconds: number): void {
    const inZone =
      this.trackerT >= this.safeCenter - this.safeHalf &&
      this.trackerT <= this.safeCenter + this.safeHalf
    if (inZone) {
      // Background drain rate is the dial that decides minimum battle
      // length. We want the *floor* (all-background, no enhanced-beat
      // successes) to be ~30s for common fish and ~50s for legendaries
      // so the song actually gets to breathe and the player feels the
      // intro → verse → chorus arc instead of one-shot kills.
      //
      // Math:   1 / (0.025 - strictness * 0.012)
      //   sardine  (str 0.40) → 50s   common   (str 0.55) → 44s
      //   tuna     (str 0.70) → 44s   epic     (str 0.82) → 65s
      //   legendary(str 0.92) → 72s
      //
      // Enhanced-beat successes (handled below) shave another ~40-50%
      // off the floor, so realistic battles land at 25-45s.
      const drainPerSec = this.initialWillpower * (0.025 - this.def.strictness * 0.012)
      this.willpower -= drainPerSec * dtSeconds
    }
  }

  private updateEvents(dtSeconds: number): void {
    if (this.eventKind === 'idle') {
      this.nextEventInMs -= dtSeconds * 1000
      if (this.nextEventInMs <= 0) {
        this.startNextEvent()
      }
      return
    }
    this.eventTimeMs += dtSeconds * 1000
    if (this.eventKind === 'follow') {
      if (this.ambient) {
        this.ctx.eventOverlay.setFollowTarget(this.ambient.x, this.ambient.y)
      }
      const tracker = this.ctx.pointer
      if (tracker.active && this.isInsideFollowRing(tracker.x, tracker.y)) {
        this.followLockProgress = Math.min(1, this.followLockProgress + dtSeconds * 0.65)
      } else {
        this.followLockProgress = Math.max(0, this.followLockProgress - dtSeconds * 0.4)
      }
      this.ctx.eventOverlay.setFollowProgress(this.followLockProgress)
      if (this.followLockProgress >= 1) {
        this.endFollowEvent(true)
      } else if (this.eventTimeMs > this.eventWindowMs) {
        this.endFollowEvent(false)
      }
    } else if (this.eventKind === 'run') {
      if (this.eventTimeMs > this.eventWindowMs) {
        if (!this.runConsumed) this.endRunEvent(false)
      }
    }
  }

  private updateUi(): void {
    this.ctx.tensionBar.setState(
      this.trackerT,
      [this.safeCenter - this.safeHalf, this.safeCenter + this.safeHalf],
      Math.min(1, this.outOfZoneMs / FISHING_CONSTANTS.tension_grace_ms),
      !(
        this.trackerT >= this.safeCenter - this.safeHalf &&
        this.trackerT <= this.safeCenter + this.safeHalf
      ),
    )
    this.ctx.willpowerBar.setState(
      Math.max(0, this.willpower / this.initialWillpower),
      this.def.color,
    )
    this.ctx.eventOverlay.update(1 / 60)
  }

  private checkOutcomes(): void {
    if (this.outOfZoneMs >= FISHING_CONSTANTS.tension_grace_ms) {
      this.snap()
      return
    }
    if (this.willpower <= 0) {
      this.win()
    }
  }

  private startNextEvent(): void {
    const wantFollow =
      this.followLocksLeft > 0 && Math.random() < 0.55 + 0.15 * Math.random()
    if (wantFollow) {
      this.eventKind = 'follow'
      this.eventTimeMs = 0
      this.eventWindowMs = 4200 + Math.random() * 1200
      this.followLockProgress = 0
      const radius = 80 - this.def.strictness * 30
      if (this.ambient) {
        this.ctx.eventOverlay.showFollow(this.ambient.x, this.ambient.y, radius)
      } else {
        this.ctx.eventOverlay.showFollow(
          this.ctx.viewport.width / 2,
          this.ctx.viewport.height * 0.6,
          radius,
        )
      }
      this.ctx.audio.playFollowCue()
    } else {
      this.eventKind = 'run'
      this.eventTimeMs = 0
      this.eventWindowMs = 2000 - this.def.strictness * 600
      this.runConsumed = false
      this.runDirection = (['up', 'down', 'left', 'right'] as Direction[])[
        Math.floor(Math.random() * 4)
      ]
      this.ctx.eventOverlay.showRun(this.runDirection)
      this.ctx.audio.playRunCue()
    }
    // The boat is "passing by a rock with a mermaid on it." She slides
    // in for the duration of the enhanced beat and visibly sings —
    // every brass/choir cue the player hears is now coming from HER.
    this.ctx.mermaidRock.show()
  }

  /**
   * Per the spec rewrite: enhanced beats ONLY swing the willpower bar.
   * They do NOT punish or reward the tension tracker; that's the
   * exclusive domain of the rhythm taps.
   *
   * A SUCCESS here also acts as the music "trigger point": it bumps the
   * soundtrack one intensity level (adding a brass / hat / bass layer)
   * and pushes the note chart up one rhythmic density tier. Both are
   * crossfades, so the player hears the arrangement physically open up
   * around the moment they nail the enhanced beat.
   */
  private endFollowEvent(success: boolean): void {
    if (success) {
      this.followLocksLeft = Math.max(0, this.followLocksLeft - 1)
      // Halved from 0.22 → 0.10 so a 30-second battle keeps fights
      // long enough for the song to actually progress through its
      // intro → verse → chorus arc. With ~4 successful events that's
      // still ~40% of willpower from enhanced beats alone.
      this.willpower -= this.initialWillpower * 0.10
      this.ctx.audio.playPerfectChime()
      this.ctx.shake(3, 0.18)
      this.bumpMusicIntensity()
    } else {
      // Failure restores some willpower (knocks back catch progress).
      this.willpower = Math.min(
        this.initialWillpower,
        this.willpower + this.initialWillpower * 0.06,
      )
      this.ctx.audio.playFail()
      this.ctx.shake(6, 0.22)
    }
    this.eventKind = 'idle'
    this.ctx.eventOverlay.hide()
    // Mermaid finishes her phrase — slides back out as the boat moves on.
    this.ctx.mermaidRock.hide()
    // Event cadence stretched so the player gets several bars of base-
    // beat play between enhanced beats — that's when the rhythm of the
    // music is actually audible.
    this.nextEventInMs = 5500 + Math.random() * 3500
  }

  private endRunEvent(success: boolean): void {
    if (success) {
      this.willpower -= this.initialWillpower * 0.12
      this.ctx.audio.playPerfectChime()
      this.ctx.shake(3, 0.18)
      this.bumpMusicIntensity()
    } else {
      this.willpower = Math.min(
        this.initialWillpower,
        this.willpower + this.initialWillpower * 0.07,
      )
      this.ctx.audio.playFail()
      this.ctx.shake(8, 0.3)
    }
    this.eventKind = 'idle'
    this.ctx.eventOverlay.hide()
    this.ctx.mermaidRock.hide()
    this.nextEventInMs = 5000 + Math.random() * 3500
  }

  /**
   * Drive both the audio layers and the visual chart density up by one
   * level, and re-arm the decay timer so the boost holds for a few
   * bars before slipping back down.
   */
  private bumpMusicIntensity(): void {
    const newLevel = this.ctx.audio.bumpMusicIntensity()
    this.ctx.noteLane.setIntensity(newLevel)
    this.decayBeatsLeft = this.intensityDecayBeats
  }

  /**
   * One step per beat (driven by the BeatClock): when the player stops
   * triggering enhanced beats, the soundtrack/chart gradually de-escalate.
   * We tick on integer beat boundaries so the decay lines up musically
   * — a layer never drops mid-phrase, it always drops on a downbeat.
   */
  private updateMusicIntensityDecay(): void {
    const beat = this.ctx.beatClock.currentBeat()
    if (beat === this.lastSeenBeat) return
    const beatsAdvanced = beat - this.lastSeenBeat
    this.lastSeenBeat = beat
    if (this.decayBeatsLeft <= 0) {
      // Already at baseline — nothing to decay.
      if (this.ctx.audio.getMusicIntensity() <= 0) return
      this.decayBeatsLeft = this.intensityDecayBeats
      return
    }
    this.decayBeatsLeft = Math.max(0, this.decayBeatsLeft - beatsAdvanced)
    if (this.decayBeatsLeft === 0 && this.ctx.audio.getMusicIntensity() > 0) {
      const next = this.ctx.audio.decayMusicIntensity()
      this.ctx.noteLane.setIntensity(next)
      this.decayBeatsLeft = next > 0 ? this.intensityDecayBeats : 0
    }
  }

  /**
   * `runDirection` is the direction the PLAYER should swipe to counter
   * the run. The arrow and text both display this direction.
   */
  private matchesRunCounter(dx: number, dy: number, speed: number): boolean {
    if (Math.hypot(dx, dy) < 35 || speed < 250) return false
    switch (this.runDirection) {
      case 'up':
        return dy < -35 && Math.abs(dy) > Math.abs(dx)
      case 'down':
        return dy > 35 && Math.abs(dy) > Math.abs(dx)
      case 'left':
        return dx < -35 && Math.abs(dx) > Math.abs(dy)
      case 'right':
        return dx > 35 && Math.abs(dx) > Math.abs(dy)
    }
  }

  private isInsidePullPanel(x: number, y: number): boolean {
    return this.ctx.pullPanel.containsGlobalPoint(x, y)
  }

  private isInsideFollowRing(x: number, y: number): boolean {
    const dx = x - this.ctx.eventOverlay.ringX
    const dy = y - this.ctx.eventOverlay.ringY
    return Math.hypot(dx, dy) <= this.ctx.eventOverlay.ringRadius
  }

  private snap(): void {
    this.ctx.audio.playFail()
    this.ctx.shake(14, 0.6)
    this.ctx.penguin.showMessage(t('game.tensionBroken'), 'sad', 1800)
    this.ctx.mermaidRock.hide()
    this.ctx.activeBiter = null
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.goTo(new SailingState(this.ctx))
  }

  private win(): void {
    this.ctx.audio.playFanfare()
    this.ctx.shake(6, 0.3)
    this.ctx.mermaidRock.hide()
    this.ctx.goTo(new CatchState(this.ctx), { def: this.def })
  }
}
