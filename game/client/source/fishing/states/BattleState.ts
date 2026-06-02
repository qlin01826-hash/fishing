import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { Direction, FishDef, FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import type { TapJudgement } from '../ui/PullPanel'
import { sectionForStage } from '../systems/AudioSystem'
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
  /**
   * Half-width of the safe zone (0..1). DYNAMIC: grows on perfect/good
   * taps, shrinks on bad/miss. When it nears `safeHalfMax`, BattleState
   * triggers a "Fish Frenzy" burst (faster willpower drain + score bonus
   * + visual celebration). Players are rewarded for sustained rhythm.
   */
  private safeHalf = 0.18
  /** Baseline width set on enter, picked from def.strictness. */
  private safeHalfBase = 0.18
  /** Floor — zone can't shrink below this even on miss spam. */
  private readonly safeHalfMin = 0.06
  /** Ceiling — at this width frenzy fires. */
  private readonly safeHalfMax = 0.48
  /** Time tracker has been outside safe zone (used for line-snap timer). */
  private outOfZoneMs = 0
  /** True while the fish is struggling (after 2 consecutive missed beats). */
  private struggling = false
  /** Direction the struggle is pushing the tracker (-1 or +1). Re-rolled when struggle starts. */
  private struggleDir = 1
  /** Saved binding to remove the pull-panel listener on exit. */
  private readonly pullListener: (j: TapJudgement, nowMs: number) => void

  // --- Layer 1b: Fish Frenzy burst ---
  /** True during the celebration window after the zone hits the ceiling. */
  private frenzyActive = false
  /** Beats remaining in the current frenzy. */
  private frenzyBeatsLeft = 0
  /** Once-per-frenzy guard so we don't re-trigger every frame at the cap. */
  private frenzyArmed = true
  /** Score awarded per frenzy beat (also paid out on tap during frenzy). */
  private readonly frenzyScorePerBeat = 3
  /** Last beat we paid out for, so the per-beat bonus doesn't double-count. */
  private frenzyLastPaidBeat = -1
  /** Minimum frenzy duration in beats (so a single peak still feels meaningful). */
  private readonly frenzyMinBeats = 8
  /** Cached auto-miss counter so we can detect FRESH misses each frame. */
  private lastSeenAutoMisses = 0

  // --- Layer 2: willpower (enhanced beats + background drain) ---
  private willpower: number
  private readonly initialWillpower: number

  // --- Difficulty (stage-driven) ---
  /** Effective strictness = max(def.strictness, stage floor). */
  private readonly effStrictness: number
  /** Stage timing-window multiplier (>1 widens forgiveness windows). */
  private readonly windowMul: number

  // --- Fish entity ---
  private ambient: AmbientFish | null = null
  private fishTargetX = 0
  private fishTargetY = 0
  private fishTargetTimer = 0

  // --- Beat-synced "tug" (reel-in jerk) ---
  /** Previous-frame beat phase for downbeat-edge detection. */
  private tugPhasePrev = 0.5
  /**
   * Tug envelope 0..1. Snaps to 1 on each beat (sharp attack) and
   * decays toward 0 between beats (release), so the hooked fish jerks
   * toward the rod in time with the music and the line twangs taut.
   */
  private tugEnvelope = 0

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
    // Stage sets the difficulty floor. Deep-water fish are tougher,
    // their windows tighter, their fights longer — regardless of the
    // individual species that happened to bite.
    const stage = ctx.progression.stage
    this.windowMul = stage.windowMul
    this.effStrictness = Math.max(this.def.strictness, stage.strictnessFloor)
    // A bigger willpower bar lengthens the patient-play floor (drain is
    // referenced to the species' BASE willpower, so the multiplier
    // doesn't just cancel out — see updateWillpowerBackground).
    this.willpower = biter.def.willpower * stage.willpowerMul
    this.initialWillpower = this.willpower
    this.followLocksLeft = biter.def.followLocks
    // Wider safe zone on shallow stages (windowMul > 1), tighter in the
    // abyss. Strictness floor also pinches it on deep fish.
    this.safeHalfBase = Math.max(0.08, 0.18 - this.effStrictness * 0.1) * stage.windowMul
    this.safeHalf = this.safeHalfBase
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
    const stage = this.ctx.progression.stage
    // Tempo baseline now comes from the STAGE; weather only nudges it a
    // few BPM either side so the song speed reads as "how deep am I"
    // rather than "how hungry is the penguin".
    const bpm = Math.round(stage.bpmBase + (intensity - 0.5) * 12)
    this.ctx.beatClock.setBpm(bpm)
    // Music complexity is driven by the depth STAGE now: deeper water
    // opens the fight in a richer section so the arrangement escalates
    // as the player descends the 15-stage ladder.
    const startSection = sectionForStage(stage.index)
    this.ctx.audio.startBeats(intensity, startSection)
    // start() resets the lane, so apply the stage's chart density range
    // + reaction speed (look-ahead) AFTER it. Look-ahead only matters in
    // update()'s spawn horizon, so post-start is the correct moment.
    this.ctx.noteLane.start()
    this.ctx.noteLane.setDensityRange(stage.noteFloor, stage.noteCap)
    this.ctx.noteLane.setLookAhead(stage.noteLookAheadBeats)
    // Mirror the audio's starting intensity into the note lane; the
    // density range above clamps it to the stage's window.
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

    // Reset frenzy / dynamic zone state so a previous battle's data
    // can't leak in.
    this.frenzyActive = false
    this.frenzyBeatsLeft = 0
    this.frenzyArmed = true
    this.frenzyLastPaidBeat = -1
    this.lastSeenAutoMisses = 0
    this.ctx.frenzyOverlay.deactivate()
    this.ctx.fishSchool.setFrenzyAmount(0)
    this.ctx.tensionBar.setFrenzy(0, 1)
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    // Tug first so the fresh offset is ready when updateFish renders
    // the fish via moveFish this same frame.
    this.updateTug(dtSeconds)
    this.updateFish(dtSeconds)
    this.updateTension(dtSeconds)
    this.updateSafeWidth(dtSeconds)
    this.updateFrenzy(dtSeconds)
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
    // Drop the frenzy celebration immediately on exit so a stale
    // overlay doesn't linger on the result banner / sailing scene.
    this.frenzyActive = false
    this.ctx.frenzyOverlay.deactivate()
    this.ctx.fishSchool.setFrenzyAmount(0)
    this.ctx.tensionBar.setFrenzy(0, 1)
    this.ctx.whale.dismiss()
    this.ctx.penguin.returnToBoat()
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
      // Track the fish's VISUAL position (swim + tug) so the bait stays
      // attached as the fish jerks on the beat. Follow speed ramps up
      // with the tug envelope so the hook snaps along with the lurch
      // instead of lagging behind and leaving a gap.
      const targetX = this.ambient.x + this.ambient.tugX
      const targetY = this.ambient.y + this.ambient.tugY
      const follow = Math.min(1, dtSeconds * (4 + this.tugEnvelope * 20))
      this.ctx.hook.fightOffsetX += (targetX - this.ctx.hook.x) * follow
      this.ctx.hook.fightOffsetY += (targetY - this.ctx.hook.y) * follow
    }
  }

  /**
   * Beat-synced "reel-in tug". On every beat the hooked fish gets a
   * sharp visual jerk toward the rod tip and the fishing line snaps
   * taut + twangs, then both ease back before the next beat. This is
   * the headline "拉拽" feedback: the fight visibly pulses with the
   * soundtrack.
   *
   * Magnitude scales with how well the player is doing — a strong, in-
   * zone reel yanks harder, a frenzy yanks hardest, and a stubborn
   * high-fight-strength fish resists (smaller jerk). The effect is
   * purely cosmetic (offsets the graphic, never the fight state), so
   * it can't unbalance the catch math.
   */
  private updateTug(dtSeconds: number): void {
    if (!this.ambient || this.ctx.hook.getMode() !== 'fight') {
      this.tugEnvelope = 0
      this.ctx.hook.setLineTension(0)
      return
    }

    const phase = this.ctx.beatClock.started
      ? this.ctx.beatClock.phase(performance.now())
      : 0.5
    // Downbeat edge: prev was late in the beat, now we've wrapped to
    // the start. Also fire on a backwards phase jump (dropped frames).
    const isBeat =
      (this.tugPhasePrev > 0.6 && phase < 0.4) ||
      phase < this.tugPhasePrev - 0.5
    if (isBeat) {
      this.tugEnvelope = 1
    }
    this.tugPhasePrev = phase
    // Sharp attack (set to 1 above) + exponential-ish release (~0.2s).
    this.tugEnvelope = Math.max(0, this.tugEnvelope - dtSeconds * 5)
    const env = this.tugEnvelope

    // Direction from the fish toward the rod tip (where it's being
    // reeled). Falls back to "straight up" if the fish is right on the
    // tip for some reason.
    const rodX = this.ctx.boat.rodTipX
    const rodY = this.ctx.boat.rodTipY
    const dx = rodX - this.ambient.x
    const dy = rodY - this.ambient.y
    const dist = Math.hypot(dx, dy)
    const nx = dist > 1 ? dx / dist : 0
    const ny = dist > 1 ? dy / dist : -1

    // In-zone reeling tugs harder; off-zone is a weaker token jerk.
    const inZone =
      this.trackerT >= this.safeCenter - this.safeHalf &&
      this.trackerT <= this.safeCenter + this.safeHalf
    const zoneMul = inZone ? 1 : 0.45
    const frenzyMul = this.frenzyActive ? 1.6 : 1
    // Strong fish resist the pull (move less per yank).
    const resist = 1 - this.def.fightStrength * 0.4
    const amount = 18 * zoneMul * frenzyMul * resist

    // Directional yank toward the rod + a high-frequency thrash so the
    // fish looks like it's fighting the line, not gliding.
    const thrash = Math.sin(performance.now() * 0.05) * env * 0.22
    this.ctx.fishSchool.setFishTug(
      this.ambient,
      nx * env * amount,
      ny * env * amount,
      thrash,
    )
    // Drive the line taut in lockstep so the whole rod→hook→fish chain
    // reads as one rhythmic pull.
    this.ctx.hook.setLineTension(env * (0.5 + 0.5 * zoneMul))
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
    // Keep the zone fully on-screen even when it's nearly full-width.
    const margin = this.safeHalf
    if (this.safeCenter < margin) this.safeCenter = margin
    if (this.safeCenter > 1 - margin) this.safeCenter = 1 - margin

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
      // Reward: zone grows. Bigger zone = easier to stay in.
      this.growSafeHalf(0.040)
      // Frenzy bonus: each perfect tap during frenzy pays out extra
      // willpower damage + score (the player feels they're shredding).
      if (this.frenzyActive) {
        this.willpower = Math.max(0, this.willpower - this.initialWillpower * 0.010)
        this.ctx.addScore(2)
      }
    } else if (judgement === 'good') {
      this.trackerT += toCenter * 0.28
      this.ctx.noteLane.consecutiveAutoMisses = 0
      this.clearStruggle()
      this.growSafeHalf(0.018)
      if (this.frenzyActive) {
        this.willpower = Math.max(0, this.willpower - this.initialWillpower * 0.006)
        this.ctx.addScore(1)
      }
    } else {
      // Explicit off-beat tap: tiny shove away, no struggle escalation
      // (auto-misses on missed BEATS are the canonical struggle trigger).
      this.trackerT -= Math.sign(toCenter) * 0.04
      this.ctx.shake(4, 0.12)
      this.shrinkSafeHalf(0.025)
    }
  }

  /**
   * Pull-side bookkeeping for note auto-misses. Two in a row triggers
   * the struggle state until the next successful hit. Each new auto-
   * miss also shrinks the safe zone (same penalty schedule as an
   * explicit bad tap) so passive players don't passively keep frenzy.
   */
  private processNoteLaneOutcomes(): void {
    const currentMisses = this.ctx.noteLane.consecutiveAutoMisses
    if (currentMisses > this.lastSeenAutoMisses) {
      const delta = currentMisses - this.lastSeenAutoMisses
      // Each fresh auto-miss is slightly less harsh than a bad TAP.
      this.shrinkSafeHalf(0.015 * delta)
    }
    this.lastSeenAutoMisses = currentMisses

    if (!this.struggling && currentMisses >= 2) {
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
      // Drain is referenced to the species' BASE willpower (not the
      // stage-scaled initial), so a larger willpower bar from
      // `willpowerMul` genuinely lengthens the patient-play floor
      // instead of cancelling out. Strictness (with the stage floor)
      // still slows the drain for tougher fish.
      const drainPerSec = this.def.willpower * (0.025 - this.effStrictness * 0.012)
      // Fish Frenzy: in-zone drain runs at 3× while the burst is active
      // so the player visibly burns through stamina during the window.
      const mult = this.frenzyActive ? 3 : 1
      this.willpower -= drainPerSec * dtSeconds * mult
    }
  }

  // ---- Layer 1b: dynamic safe-zone width + Fish Frenzy ----

  /** Grow the safe zone (player reward). Snaps at `safeHalfMax`. */
  private growSafeHalf(delta: number): void {
    this.safeHalf = Math.min(this.safeHalfMax, this.safeHalf + delta)
  }

  /** Shrink the safe zone (penalty). Clamped at `safeHalfMin`. */
  private shrinkSafeHalf(delta: number): void {
    this.safeHalf = Math.max(this.safeHalfMin, this.safeHalf - delta)
  }

  /**
   * Per-beat passive decay on the safe zone width — keeps the player
   * actively engaged. Without this, a single perfect streak could buy
   * a permanently large zone with no follow-up effort.
   *
   * The decay is **paused during frenzy** (the burst should feel rich
   * and stable) and is much weaker than gain so a competent player
   * still trends upward.
   */
  private updateSafeWidth(_dtSeconds: number): void {
    if (this.frenzyActive) return
    const beat = this.ctx.beatClock.currentBeat()
    if (beat === this.lastSeenBeat) return
    // (decay actually happens via updateMusicIntensityDecay which also
    // tracks beat ticks — we piggy-back on its delta here so we don't
    // need a second beat-tracker.)
    const delta = beat - this.lastSeenBeat
    if (delta > 0) {
      this.shrinkSafeHalf(0.008 * delta)
    }
  }

  /**
   * Frenzy lifecycle: arm/trigger/maintain/end + drive the visual
   * overlays each frame.
   */
  private updateFrenzy(dtSeconds: number): void {
    const ratio = this.safeHalf / this.safeHalfMax

    // ARM/TRIGGER: zone reached the ceiling and the previous burst has
    // already ended (so we don't re-fire on every frame at the cap).
    if (!this.frenzyActive && this.frenzyArmed && ratio >= 0.95) {
      this.startFrenzy()
    }

    // MAINTAIN: tick down beats; pay out the per-beat score bonus once
    // per integer beat advance.
    if (this.frenzyActive) {
      const beat = this.ctx.beatClock.currentBeat()
      if (beat !== this.frenzyLastPaidBeat) {
        if (this.frenzyLastPaidBeat >= 0) {
          const beatsAdvanced = Math.max(0, beat - this.frenzyLastPaidBeat)
          this.frenzyBeatsLeft = Math.max(0, this.frenzyBeatsLeft - beatsAdvanced)
          this.ctx.addScore(this.frenzyScorePerBeat * beatsAdvanced)
        }
        this.frenzyLastPaidBeat = beat
      }
      // END: either we ran out of beats AND the player let the zone
      // collapse, OR the zone has dropped well below the cap regardless
      // of beats. Brief grace either way so a single tap-miss can't
      // immediately yank the celebration.
      const beatsExhausted = this.frenzyBeatsLeft <= 0
      const zoneCollapsed = this.safeHalf < this.safeHalfMax * 0.55
      if (beatsExhausted && zoneCollapsed) {
        this.endFrenzy()
      }
    }

    // OVERLAY/UI: drive the frenzy intensity into the cosmetic layers
    // each frame so transitions stay smooth even when frenzy itself
    // ticks on integer beats. FrenzyOverlay's own .update() is driven
    // centrally by FishingScene so its exit animation can finish even
    // after BattleState has torn down.
    const targetT = this.frenzyActive ? 1 : Math.max(0, (ratio - 0.55) / 0.45) * 0.4
    this.ctx.tensionBar.setFrenzy(targetT, dtSeconds)
    this.ctx.fishSchool.setFrenzyAmount(this.frenzyActive ? 1 : targetT * 0.3)
    // Pipe BeatClock phase to the school so all the fish wag together.
    this.ctx.fishSchool.setBeatPhase(
      this.ctx.beatClock.started ? this.ctx.beatClock.phase(performance.now()) : 0.5,
    )
    // Keep the penguin's swim orbit centred on the boat as it bobs.
    if (this.frenzyActive) {
      const boatX = this.ctx.boat.deckCenterX
      const orbitY = this.ctx.viewport.waterLineY + 28
      const rx = Math.min(140, this.ctx.viewport.width * 0.18)
      const ry = Math.min(40, this.ctx.viewport.height * 0.07)
      this.ctx.penguin.swimAroundBoat(boatX, orbitY, rx, ry)
    }
  }

  private startFrenzy(): void {
    this.frenzyActive = true
    this.frenzyArmed = false
    this.frenzyBeatsLeft = this.frenzyMinBeats
    this.frenzyLastPaidBeat = this.ctx.beatClock.currentBeat()
    // Audio: push intensity up two layers so the chorus opens up
    // around the player.
    const lvl = this.ctx.audio.bumpMusicIntensity()
    this.ctx.audio.bumpMusicIntensity()
    this.ctx.noteLane.setIntensity(Math.max(lvl, this.ctx.audio.getMusicIntensity()))
    this.ctx.audio.playPerfectChime()
    this.ctx.frenzyOverlay.activate()
    this.ctx.shake(5, 0.35)

    // Spectacle: more fish, a guest whale, and the penguin dives in
    // to swim around the boat.
    this.ctx.fishSchool.triggerFrenzyBurst(12)
    this.ctx.whale.appear(this.ctx.viewport)
    // Orbit centred on the boat, sitting just below the waterline so
    // the penguin clearly dives INTO the sea instead of running laps
    // on top of it. Radii scale to viewport so it stays in-frame even
    // on small phones.
    const boatX = this.ctx.boat.deckCenterX
    const orbitY = this.ctx.viewport.waterLineY + 28
    const rx = Math.min(140, this.ctx.viewport.width * 0.18)
    const ry = Math.min(40, this.ctx.viewport.height * 0.07)
    this.ctx.penguin.swimAroundBoat(boatX, orbitY, rx, ry)
    // Penguin can't contain its excitement — star eyes for the duration
    // of the frenzy. We don't bother restoring it here; SailingState
    // re-picks a mood based on hunger as soon as the battle resolves.
    this.ctx.penguin.setMood('excited')
  }

  private endFrenzy(): void {
    this.frenzyActive = false
    this.frenzyBeatsLeft = 0
    // Reset zone to a high but achievable value so the player has to
    // re-earn the next burst, not coast on residual width.
    this.safeHalf = Math.min(this.safeHalf, this.safeHalfMax * 0.55)
    this.ctx.frenzyOverlay.deactivate()
    // Re-arm so the next time the player drives the zone back up to the
    // ceiling, another frenzy fires.
    this.frenzyArmed = true
    // Send the cameo cast home.
    this.ctx.whale.dismiss()
    this.ctx.penguin.returnToBoat()
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
      this.eventWindowMs = (4200 + Math.random() * 1200) * this.windowMul
      this.followLockProgress = 0
      const radius = (80 - this.effStrictness * 30) * this.windowMul
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
      this.eventWindowMs = (2000 - this.effStrictness * 600) * this.windowMul
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
    // Feed the skill signal (used by the progression curve in the next
    // step; harmless no-op on difficulty for now).
    this.ctx.progression.reportSnap()
    this.ctx.shake(14, 0.6)
    // Worried takes over right as the line snaps — sweat-drop emotes
    // sell the panic better than the previous flat sadness.
    this.ctx.penguin.showMessage(t('game.tensionBroken'), 'worried', 1800)
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
