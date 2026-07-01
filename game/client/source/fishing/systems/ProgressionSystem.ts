/**
 * ProgressionSystem — the single, legible difficulty axis for a run.
 *
 * The run descends through 15 depth stages, advancing ONE stage per
 * fish landed. Difficulty ramps a little on every single catch (tempo,
 * fight length, timing strictness, reaction time) so the climb is felt
 * continuously rather than in a few big jumps.
 *
 * The 15 stages are grouped into 5 named ZONES (3 stages each):
 *   shallows → coast → deep → abyss → abyssDeep
 * A "进入XX海域" banner fires only when crossing a zone boundary (5×
 * per run) so the announcement never spams on every catch.
 *
 * Each stage also exposes a `depthMood` (0..1) that the scene uses to
 * darken the water and crank up the "descending into the abyss"
 * atmosphere, and a `tier` the music uses to escalate arrangement
 * complexity.
 *
 * `momentum` (a skill signal) is reserved for the next step — the
 * field/hooks exist but are intentionally inert for now.
 */
export interface StageProfile {
  /** 0-based stage index (0..14). */
  index: number
  /** Normalised depth 0..1 across the whole ladder. */
  tier: number
  /** Zone index 0..4 (shallows…abyssDeep). */
  zone: number
  /** i18n key suffix for the current zone (`stage.<name>`). */
  name: string
  /** Battle tempo baseline before the weather nudge. */
  bpmBase: number
  /** Timing-window multiplier (>1 widens forgiveness, <1 tightens). */
  windowMul: number
  /** Minimum NoteLane density tier this stage drops to. */
  noteFloor: number
  /** Maximum NoteLane density tier this stage allows. */
  noteCap: number
  /** Note look-ahead in beats — lower = less reaction time = harder. */
  noteLookAheadBeats: number
  /** Multiplier on the biter's initial willpower (longer fights deeper). */
  willpowerMul: number
  /** Floor applied to the biter's `strictness`. */
  strictnessFloor: number
  /**
   * Visual "abyss" intensity 0..1. Stays 0 through the bright shallows
   * and ramps to 1 in the deepest stage, so the scene darkens and the
   * mood turns ominous as the player descends.
   */
  depthMood: number
}

const STAGE_COUNT = 15
const STAGES_PER_ZONE = 3
/** i18n suffixes resolved as `stage.<name>`. One per zone. */
const ZONE_NAMES = ['shallows', 'coast', 'deep', 'abyss', 'abyssDeep'] as const

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** Build the (precomputed) profile for a given stage index. */
function buildProfile(index: number): StageProfile {
  const maxIndex = STAGE_COUNT - 1
  const tier = maxIndex > 0 ? index / maxIndex : 0
  // Ease-in ramp for the *tightening* params (tempo, windows, reaction time,
  // strictness): keeps the opening stages gentle and pushes the steep part of
  // the curve toward the deep water, so difficulty doesn't spike on fish #1.
  const rampT = Math.pow(tier, 1.6)
  const zone = Math.min(ZONE_NAMES.length - 1, Math.floor(index / STAGES_PER_ZONE))
  // Density cap climbs 1 → 3 across the run (chart patterns top out at
  // L3). Floor trails one tier behind so deep water never goes trivial.
  // Eased so the cap holds at 1 for the first few catches before climbing.
  const noteCap = Math.max(1, Math.min(3, Math.round(1 + rampT * 2)))
  const noteFloor = Math.max(0, noteCap - 1)
  return {
    index,
    tier,
    zone,
    name: ZONE_NAMES[zone],
    bpmBase: Math.round(lerp(72, 138, rampT)),
    windowMul: lerp(1.55, 0.8, rampT),
    noteFloor,
    noteCap,
    noteLookAheadBeats: lerp(3.0, 1.45, rampT),
    // Longer fights overall, with a much higher floor early so the first
    // catches actually last and let the music breathe.
    willpowerMul: lerp(1.25, 2.0, tier),
    // Strictness floor stays 0 through the shallows, then ramps in (eased).
    strictnessFloor: Math.max(0, lerp(-0.25, 0.82, rampT)),
    // Bright shallows still start at 0, but voyage now drives visuals from t=0.
    depthMood: clamp01((index - 1) / Math.max(1, maxIndex - 1)),
  }
}

const STAGES: readonly StageProfile[] = Array.from({ length: STAGE_COUNT }, (_unused, i) =>
  buildProfile(i),
)

export class ProgressionSystem {
  /** Total fish landed this run (== stage index, capped at the bottom). */
  private catches = 0
  /** Current stage ladder index 0..14. */
  private stageIndex = 0
  /** Set true the frame a stage advances; consumed by per-stage feedback. */
  private stageJustAdvanced = false
  /** Set true the frame a ZONE advances; consumed by the banner. */
  private zoneJustAdvanced = false

  /**
   * Skill signal 0..1 — RESERVED for the next step. Rises with clean
   * play, falls on snaps. Inert for now.
   */
  private momentum = 0.4

  /** The active stage profile. */
  get stage(): StageProfile {
    return STAGES[this.stageIndex]
  }

  /** Active stage index (0-based). */
  get index(): number {
    return this.stageIndex
  }

  /** Highest stage index reachable. */
  get maxIndex(): number {
    return STAGE_COUNT - 1
  }

  /** Total fish caught this run. */
  get totalCaught(): number {
    return this.catches
  }

  /** Visual abyss intensity 0..1 for the current stage. */
  get depthMood(): number {
    return STAGES[this.stageIndex].depthMood
  }

  /** Normalised depth 0..1 for the current stage. */
  get tier(): number {
    return STAGES[this.stageIndex].tier
  }

  /** Reserved skill signal (read-only for now). */
  get momentumValue(): number {
    return this.momentum
  }

  /**
   * Record a successful catch and advance one stage. Returns true when
   * a stage-up happened (always true until the bottom stage is reached).
   */
  reportCatch(): boolean {
    this.catches += 1
    const target = Math.min(STAGE_COUNT - 1, this.catches)
    if (target > this.stageIndex) {
      const prevZone = STAGES[this.stageIndex].zone
      this.stageIndex = target
      this.stageJustAdvanced = true
      if (STAGES[this.stageIndex].zone > prevZone) this.zoneJustAdvanced = true
      this.legProgress = 0
      this.voyageProgress = this.stageIndex / Math.max(1, STAGE_COUNT - 1)
      return true
    }
    return false
  }

  /**
   * Record a line snap (lost fish). Currently only nudges the reserved
   * momentum signal; no mechanical effect until the next step.
   */
  reportSnap(): void {
    this.momentum = Math.max(0, this.momentum - 0.25)
  }

  /** Read-and-clear the per-stage "advanced" flag. */
  consumeStageUp(): boolean {
    const v = this.stageJustAdvanced
    this.stageJustAdvanced = false
    return v
  }

  /** Read-and-clear the "entered a new zone" flag (drives the banner). */
  consumeZoneUp(): boolean {
    const v = this.zoneJustAdvanced
    this.zoneJustAdvanced = false
    return v
  }

  /** Continuous 0..1 voyage position — boat sailing through the 15 legs. */
  private voyageProgress = 0
  /** Progress 0..1 within the current stage leg (between catches). */
  private legProgress = 0
  /** Cumulative world scroll in px — drives visible forward motion. */
  private worldScrollPx = 0
  /** When true the voyage is anchored (hook dropped) — no scroll advance. */
  private voyageFrozen = false

  /** Current voyage position 0..1 (advances while the boat is underway). */
  get voyage(): number {
    return this.voyageProgress
  }

  /** Pixel distance sailed this run — used for parallax and seabed shift. */
  get scroll(): number {
    return this.worldScrollPx
  }

  /**
   * Depth atmosphere from geographic position along the voyage, so the
   * scene darkens gradually while sailing — not only on catch.
   */
  getVoyageDepthMood(): number {
    return clamp01(this.voyageProgress)
  }

  /**
   * Advance the voyage while the boat is moving. Scroll accumulates in
   * pixels so the scene visibly leaves the beach within seconds.
   */
  updateVoyage(dtSeconds: number, underway: boolean, viewportWidth: number): void {
    if (!underway || this.voyageFrozen) return
    const legSpan = 1 / Math.max(1, STAGE_COUNT - 1)
    // Cruise pace cut to 30% of the old value so each sea zone lingers ~3× as
    // long — the player has room to choose where to drop the hook.
    const legSpeed = 0.0165
    this.legProgress = Math.min(0.98, this.legProgress + dtSeconds * legSpeed)
    const base = this.stageIndex / Math.max(1, STAGE_COUNT - 1)
    const legVoyage = Math.min(1, base + this.legProgress * legSpan)

    const runSpan = Math.max(400, viewportWidth * 4.5)
    const depthMul = 1 + this.stageIndex * 0.14 + legVoyage * 0.2
    this.worldScrollPx += dtSeconds * 42 * depthMul
    const scrollVoyage = clamp01(this.worldScrollPx / runSpan)
    this.voyageProgress = Math.max(legVoyage, scrollVoyage)
  }

  /**
   * Hard-freeze the voyage the instant the hook drops so the boat stays anchored
   * in the exact sea zone the player chose (progress bar + scroll stop dead).
   */
  freezeVoyage(): void {
    this.voyageFrozen = true
  }

  /** Release the anchor when a fresh sailing leg begins. */
  unfreezeVoyage(): void {
    this.voyageFrozen = false
  }

  /** Reset for a brand-new run. */
  reset(): void {
    this.catches = 0
    this.stageIndex = 0
    this.stageJustAdvanced = false
    this.zoneJustAdvanced = false
    this.momentum = 0.4
    this.voyageProgress = 0
    this.legProgress = 0
    this.worldScrollPx = 0
    this.voyageFrozen = false
  }
}
