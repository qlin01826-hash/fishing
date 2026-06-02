/**
 * ProgressionSystem — the single, legible difficulty axis for a run.
 *
 * Replaces the old "difficulty is whatever hunger happens to be" model
 * with an explicit **stage** ladder (浅滩 → 近海 → 深海 → 深渊 → 深渊+)
 * that climbs as the player lands fish. Each stage raises the floor on
 * every battle knob (tempo, fight length, timing strictness, chart
 * density, reaction time), so battle #10 is meaningfully harder than
 * battle #1 instead of identical-after-4-catches.
 *
 * Hunger/weather is demoted to a small per-battle modifier layered on
 * top of the stage baseline (see BattleState), so the two axes no
 * longer fight each other.
 *
 * `momentum` (a skill signal that nudges difficulty within a stage and
 * speeds/slows climbing) is reserved for the next step — the field and
 * hooks exist here but are intentionally inert for now.
 */
export interface StageProfile {
  /** 0-based ladder index. */
  index: number
  /** i18n key suffix (resolved as `stage.<name>`). */
  name: string
  /** Battle tempo baseline before the weather nudge. */
  bpmBase: number
  /**
   * Timing-window multiplier. >1 widens every forgiveness window
   * (safe zone, follow ring, run swipe) for a gentle on-ramp; <1
   * tightens them for the deep end.
   */
  windowMul: number
  /** Minimum NoteLane density tier this stage ever drops to. */
  noteFloor: number
  /** Maximum NoteLane density tier this stage allows. */
  noteCap: number
  /**
   * Note look-ahead in beats. Lower = notes appear later = less
   * reaction time = harder. The default playfield value is 2.
   */
  noteLookAheadBeats: number
  /** Multiplier on the biter's initial willpower (longer fights deeper). */
  willpowerMul: number
  /** Floor applied to the biter's `strictness` (deep fish are never sloppy). */
  strictnessFloor: number
}

/**
 * The stage ladder. Tuned as a first pass — every number here is a
 * difficulty dial and is expected to need playtest adjustment.
 *
 * `noteCap` is held at 3 because the NoteLane chart currently tops out
 * at an eighth-note groove (8 taps/bar). The deep stages lean on
 * tighter windows + faster look-ahead for their extra bite instead of
 * denser charts; true 16th-note tiers are a separate follow-up.
 */
const STAGES: readonly StageProfile[] = [
  {
    index: 0,
    name: 'shallows',
    bpmBase: 80,
    windowMul: 1.4,
    noteFloor: 0,
    noteCap: 1,
    noteLookAheadBeats: 2.4,
    willpowerMul: 0.8,
    strictnessFloor: 0.0,
  },
  {
    index: 1,
    name: 'coast',
    bpmBase: 92,
    windowMul: 1.15,
    noteFloor: 1,
    noteCap: 2,
    noteLookAheadBeats: 2.1,
    willpowerMul: 1.0,
    strictnessFloor: 0.0,
  },
  {
    index: 2,
    name: 'deep',
    bpmBase: 104,
    windowMul: 1.0,
    noteFloor: 2,
    noteCap: 3,
    noteLookAheadBeats: 1.9,
    willpowerMul: 1.15,
    strictnessFloor: 0.4,
  },
  {
    index: 3,
    name: 'abyss',
    bpmBase: 116,
    windowMul: 0.9,
    noteFloor: 2,
    noteCap: 3,
    noteLookAheadBeats: 1.7,
    willpowerMul: 1.3,
    strictnessFloor: 0.6,
  },
  {
    index: 4,
    name: 'abyssDeep',
    bpmBase: 126,
    windowMul: 0.85,
    noteFloor: 3,
    noteCap: 3,
    noteLookAheadBeats: 1.55,
    willpowerMul: 1.5,
    strictnessFloor: 0.7,
  },
]

export class ProgressionSystem {
  /** Total fish landed this run (drives stage advancement). */
  private catches = 0
  /** Current stage ladder index. */
  private stageIndex = 0
  /** Fish needed to clear each stage. */
  private readonly catchesPerStage = 3
  /** Set true the frame a stage-up happens; consumed by the banner. */
  private stageJustAdvanced = false

  /**
   * Skill signal 0..1 — RESERVED for the next step. Rises with clean
   * play, falls on line snaps; will fine-tune within-stage difficulty
   * and climb speed. Inert for now.
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
    return STAGES.length - 1
  }

  /** Total fish caught this run. */
  get totalCaught(): number {
    return this.catches
  }

  /** Reserved skill signal (read-only for now). */
  get momentumValue(): number {
    return this.momentum
  }

  /**
   * Record a successful catch and advance the stage if a threshold was
   * crossed. Returns true when this catch triggered a stage-up.
   */
  reportCatch(): boolean {
    this.catches += 1
    const target = Math.min(
      STAGES.length - 1,
      Math.floor(this.catches / this.catchesPerStage),
    )
    if (target > this.stageIndex) {
      this.stageIndex = target
      this.stageJustAdvanced = true
      return true
    }
    return false
  }

  /**
   * Record a line snap (lost fish). Currently only nudges the reserved
   * momentum signal; has no mechanical effect until the next step.
   */
  reportSnap(): void {
    this.momentum = Math.max(0, this.momentum - 0.25)
  }

  /**
   * Read-and-clear the "just advanced" flag. The sailing phase polls
   * this to announce the new stage exactly once.
   */
  consumeStageUp(): boolean {
    const v = this.stageJustAdvanced
    this.stageJustAdvanced = false
    return v
  }

  /** Reset for a brand-new run. */
  reset(): void {
    this.catches = 0
    this.stageIndex = 0
    this.stageJustAdvanced = false
    this.momentum = 0.4
  }
}
