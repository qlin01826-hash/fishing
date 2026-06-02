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
  const zone = Math.min(ZONE_NAMES.length - 1, Math.floor(index / STAGES_PER_ZONE))
  // Density cap climbs 1 → 3 across the run (chart patterns top out at
  // L3). Floor trails one tier behind so deep water never goes trivial.
  const noteCap = Math.max(1, Math.min(3, Math.round(1 + tier * 2)))
  const noteFloor = Math.max(0, noteCap - 1)
  return {
    index,
    tier,
    zone,
    name: ZONE_NAMES[zone],
    bpmBase: Math.round(lerp(78, 140, tier)),
    windowMul: lerp(1.45, 0.78, tier),
    noteFloor,
    noteCap,
    noteLookAheadBeats: lerp(2.5, 1.4, tier),
    willpowerMul: lerp(0.8, 1.7, tier),
    // Strictness floor stays 0 through the shallows, then ramps in.
    strictnessFloor: Math.max(0, lerp(-0.2, 0.82, tier)),
    // Bright shallows (stages 0–2) keep depthMood at 0; the descent
    // proper begins after, ramping to full dark in the abyss.
    depthMood: clamp01((index - 2) / (maxIndex - 2)),
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

  /** Reset for a brand-new run. */
  reset(): void {
    this.catches = 0
    this.stageIndex = 0
    this.stageJustAdvanced = false
    this.zoneJustAdvanced = false
    this.momentum = 0.4
  }
}
