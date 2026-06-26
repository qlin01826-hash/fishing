import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishDef, FishingStateId } from '../types'
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
 * Fight phase — same rhythm shell as sailing / lure:
 *
 * **One action per downbeat**: tap {@link PullPanel} (or SPACE) on the beat.
 *
 * - **Tension bar (top)**: Perfect/Good pulls the marker toward the safe
 *   zone; two consecutive missed downbeats → STRUGGLE (marker drifts out).
 *   Stay out too long → line snap.
 * - **Willpower bar (right)**: Each on-beat Perfect/Good shaves willpower;
 *   holding inside the safe zone adds a slow background drain. Willpower
 *   at zero → catch.
 *
 * NoteLane and follow/run overlays are intentionally unused here so the
 * player reads one metronome, not two parallel rhythm games.
 */
/** Willpower chunk removed per on-beat tap (fraction of initial bar). */
const WP_DRAIN_PERFECT = 0.075
const WP_DRAIN_GOOD = 0.042

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
  private readonly pullListener: (j: TapJudgement, nowMs: number, beatPhase: number) => void

  /** Once-per-fight guard so deviation failure doesn't re-fire every frame. */
  private overboardPlaying = false

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
  /** Consecutive downbeats without an on-beat Perfect/Good tap. */
  private consecutiveBeatMisses = 0
  /** Set true when the player lands Perfect/Good on the current beat. */
  private beatHitThisDownbeat = false
  private prevDownbeatPhase = 0.5

  // --- Layer 2: willpower (on-beat taps + background drain) ---
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

  /** Beat index for passive safe-zone shrink (one step per downbeat). */
  private lastSafeDecayBeat = 0

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
    // Wider safe zone on shallow stages (windowMul > 1), tighter in the
    // abyss. Strictness floor also pinches it on deep fish.
    this.safeHalfBase = Math.max(0.08, 0.18 - this.effStrictness * 0.1) * stage.windowMul
    this.safeHalf = this.safeHalfBase
    this.pullListener = (j, now, beatPhase) => this.onPullJudgement(j, now, beatPhase)
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
    this.ctx.noteLane.container.visible = false
    this.ctx.pullPanel.reset()
    this.ctx.pullPanel.setMode('battle')
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.hide()
    this.ctx.boat.resetDeviation()

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
    const lockedBpm = this.ctx.audio.getLockedBpm()
    const bpm = lockedBpm ?? Math.round(stage.bpmBase + (intensity - 0.5) * 12)
    this.ctx.beatClock.setBpm(bpm)
    // Music complexity is driven by the depth STAGE now: deeper water
    // opens the fight in a richer section so the arrangement escalates
    // as the player descends the 15-stage ladder.
    const startSection = sectionForStage(stage.index)
    // The groove bed is already running continuously; LIFT it up to the
    // battle section instead of (re)starting the song, so there's no gap
    // or restart pop when a fight begins. startGrooveBed() is a safety
    // net in case audio only just unlocked this very frame.
    this.ctx.audio.startGrooveBed()
    // setBpm() above rebased the beat clock; the bed was already running
    // from sailing, so re-anchor the scheduler or it would stall and the
    // music would cut out the moment the fight starts.
    this.ctx.audio.resyncScheduler()
    this.ctx.audio.riseToSection(startSection)

    this.ctx.pullPanel.onJudgement = this.pullListener
    this.ctx.penguin.showMessage(t('game.battlePullHint'), 'excited', 2200)

    this.frenzyActive = false
    this.frenzyBeatsLeft = 0
    this.frenzyArmed = true
    this.frenzyLastPaidBeat = -1
    this.consecutiveBeatMisses = 0
    this.beatHitThisDownbeat = false
    this.prevDownbeatPhase = this.ctx.beatClock.started ? this.ctx.beatClock.phase() : 0.5
    this.lastSafeDecayBeat = this.ctx.beatClock.currentBeat()
    this.overboardPlaying = false
    this.ctx.frenzyOverlay.deactivate()
    this.ctx.fishSchool.setFrenzyAmount(0)
    this.ctx.tensionBar.setFrenzy(0, 1)
  }

  update(dtSeconds: number, _elapsedMs: number): void {
    if (this.overboardPlaying) {
      this.ctx.pullPanel.update(dtSeconds, performance.now())
      return
    }
    // Tug first so the fresh offset is ready when updateFish renders
    // the fish via moveFish this same frame.
    this.updateTug(dtSeconds)
    this.updateFish(dtSeconds)
    this.checkDownbeat()
    this.updateTension(dtSeconds)
    this.updateSafeWidth(dtSeconds)
    this.updateFrenzy(dtSeconds)
    this.ctx.pullPanel.update(dtSeconds, performance.now())
    this.updateWillpowerBackground(dtSeconds)
    this.updateUi()
    if (this.ctx.boat.getDeviation() >= 1 || this.ctx.boat.getWaveSubmerge() >= 0.92) {
      this.overboardFail()
      return
    }
    this.checkOutcomes()
  }

  // ---- pointer routing ----

  onPointerDown(_x: number, _y: number, _pointerId: number): void {}

  onPointerMove(_x: number, _y: number, _pointerId: number): void {}

  onPointerUp(_x: number, _y: number, pointerId: number): void {
    this.ctx.pointer.pointerUp(pointerId)
  }

  exit(): void {
    this.ctx.tensionBar.container.visible = false
    this.ctx.willpowerBar.container.visible = false
    this.ctx.pullPanel.container.visible = false
    this.ctx.noteLane.container.visible = false
    this.ctx.noteLane.stop()
    this.ctx.eventOverlay.hide()
    // Don't silence the song when the fight ends — ease it back down to
    // the continuous resting bed so sailing/waiting still has music.
    this.ctx.audio.relaxToBed()
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
      const baseRange = this.struggling ? 160 : 90
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
  private onPullJudgement(judgement: TapJudgement, _nowMs: number, beatPhase: number): void {
    this.ctx.boat.applyRhythmJudgement(judgement, beatPhase)
    if (judgement === 'perfect' || judgement === 'good') {
      this.ctx.ocean.triggerWaveBreak(judgement === 'perfect' ? 1 : 0.65)
      this.ctx.ocean.triggerCrestBurst(this.ctx.boat.deckCenterX)
      this.beatHitThisDownbeat = true
      this.consecutiveBeatMisses = 0
    } else {
      this.ctx.shake(5, 0.22)
    }

    const toCenter = this.safeCenter - this.trackerT
    if (judgement === 'perfect') {
      this.trackerT += toCenter * 0.55
      this.clearStruggle()
      this.growSafeHalf(0.040)
      this.willpower = Math.max(0, this.willpower - this.initialWillpower * WP_DRAIN_PERFECT)
      if (this.frenzyActive) {
        this.willpower = Math.max(0, this.willpower - this.initialWillpower * 0.012)
        this.ctx.addScore(2)
      }
    } else if (judgement === 'good') {
      this.trackerT += toCenter * 0.28
      this.clearStruggle()
      this.growSafeHalf(0.018)
      this.willpower = Math.max(0, this.willpower - this.initialWillpower * WP_DRAIN_GOOD)
      if (this.frenzyActive) {
        this.willpower = Math.max(0, this.willpower - this.initialWillpower * 0.007)
        this.ctx.addScore(1)
      }
    } else {
      this.trackerT -= Math.sign(toCenter) * 0.04
      this.ctx.shake(4, 0.12)
      this.shrinkSafeHalf(0.025)
    }
  }

  private checkDownbeat(): void {
    const clock = this.ctx.beatClock
    if (!clock.started) return
    const phase = clock.phase()
    const isDownbeat =
      (this.prevDownbeatPhase > 0.6 && phase < 0.4) || phase < this.prevDownbeatPhase - 0.5
    if (isDownbeat) this.onBattleDownbeat()
    this.prevDownbeatPhase = phase
  }

  /** End of beat window — player must have landed Perfect/Good since last downbeat. */
  private onBattleDownbeat(): void {
    if (!this.beatHitThisDownbeat) {
      this.consecutiveBeatMisses += 1
      this.shrinkSafeHalf(0.014)
      if (!this.struggling && this.consecutiveBeatMisses >= 2) {
        this.struggling = true
        this.struggleDir = Math.sign(this.trackerT - this.safeCenter) || (Math.random() < 0.5 ? -1 : 1)
        this.ctx.pullPanel.setStruggling(true)
        this.ctx.shake(8, 0.35)
        this.ctx.audio.playFail()
      }
    } else {
      this.consecutiveBeatMisses = 0
    }
    this.beatHitThisDownbeat = false
  }

  private clearStruggle(): void {
    if (this.struggling) {
      this.struggling = false
      this.consecutiveBeatMisses = 0
      this.ctx.pullPanel.setStruggling(false)
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
    if (beat === this.lastSafeDecayBeat) return
    const delta = beat - this.lastSafeDecayBeat
    this.lastSafeDecayBeat = beat
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
    this.ctx.audio.bumpMusicIntensity()
    this.ctx.audio.bumpMusicIntensity()
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

  private overboardFail(): void {
    if (this.overboardPlaying) return
    this.overboardPlaying = true
    this.ctx.pullPanel.container.visible = false
    this.ctx.audio.playFail()
    this.ctx.progression.reportSnap()
    this.ctx.shake(14, 0.65)
    this.ctx.mermaidRock.hide()
    this.ctx.activeBiter = null
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    if (this.ambient) {
      this.ctx.fishSchool.remove(this.ambient)
      this.ambient = null
    }
    this.ctx.penguin.triggerOverboardFailure(() => {
      this.ctx.boat.resetDeviation()
      this.ctx.penguin.returnToBoat()
      this.ctx.penguin.showMessage(t('game.overboardFail'), 'sad', 3200)
      this.ctx.goTo(new SailingState(this.ctx))
    })
  }

  private win(): void {
    this.ctx.audio.playFanfare()
    this.ctx.shake(6, 0.3)
    this.ctx.mermaidRock.hide()
    this.ctx.goTo(new CatchState(this.ctx), { def: this.def })
  }
}
