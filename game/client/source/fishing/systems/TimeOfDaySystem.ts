/**
 * Real-time day/night cycle that drives the sky, ocean, horizon, and
 * any "moonlit" entity decorations.
 *
 * Unlike WeatherSystem (which is hunger-driven and reactive), this
 * cycle ticks purely on wall-clock seconds so the world quietly
 * rotates through day → dusk → night → dawn while the player fishes.
 *
 * Output is a single immutable snapshot per frame. The trig math is
 * intentionally simple — a cosine of normalised cycle time gives both
 * sun altitude AND a free, butter-smooth "nightPhase" gradient that
 * scales every other system from noon (0) to midnight (1).
 */

export type TimeOfDayPeriod = 'day' | 'dusk' | 'night' | 'dawn'

export interface TimeOfDaySnapshot {
  /** 0 at high noon, 1 at midnight. Cosine-smooth. */
  nightPhase: number
  /** 0..1, peaks at noon, zero below horizon (after dusk). */
  sunAltitude: number
  /** 0..1, peaks at midnight, zero before dusk. */
  moonAltitude: number
  /** Horizontal arc position (0 = east, 0.5 = zenith, 1 = west). */
  sunArcX: number
  moonArcX: number
  /** 0..1 visibility of stars (only nonzero past dusk). */
  starOpacity: number
  /** Coarse bucket label — useful for audio/UI cues if we ever want them. */
  period: TimeOfDayPeriod
}

const DAY_NIGHT_CYCLE_SEC = 300 // 5 real-time minutes per full cycle

export class TimeOfDaySystem {
  private elapsedSec = 0
  private snapshot: TimeOfDaySnapshot = makeSnapshot(0)

  /**
   * Skip ahead so the game doesn't always start at "noon flat lighting".
   * Picking a phase between 0.05 and 0.18 means new sessions usually
   * open in late morning / early afternoon — clearly daylit but with
   * the sun visibly off-zenith for some shape.
   */
  constructor() {
    this.elapsedSec = (0.05 + Math.random() * 0.13) * DAY_NIGHT_CYCLE_SEC
    this.snapshot = makeSnapshot(this.elapsedSec / DAY_NIGHT_CYCLE_SEC)
  }

  update(dtSeconds: number): void {
    this.elapsedSec = (this.elapsedSec + dtSeconds) % DAY_NIGHT_CYCLE_SEC
    this.snapshot = makeSnapshot(this.elapsedSec / DAY_NIGHT_CYCLE_SEC)
  }

  get(): TimeOfDaySnapshot {
    return this.snapshot
  }
}

function makeSnapshot(t: number): TimeOfDaySnapshot {
  // t in [0, 1). 0 = noon, 0.5 = midnight.
  // sunCos: 1 at noon, -1 at midnight (passes through 0 at dawn/dusk).
  const sunCos = Math.cos(t * Math.PI * 2)
  const sunAltitude = Math.max(0, sunCos)
  const moonAltitude = Math.max(0, -sunCos)
  // nightPhase: smooth 0..1 driven by sunCos.
  const nightPhase = (1 - sunCos) / 2
  // Arc positions: sun travels east → zenith → west over half a cycle,
  // then disappears below the horizon while the moon retraces.
  //   t=0      noon, sun at 0.5 (zenith centre)
  //   t=0.125  sun at ~0.85 (afternoon)
  //   t=0.25   sunset west (1.0)
  //   t=0.75   sunrise east (0.0)
  const sunArcX = 0.5 + Math.sin(t * Math.PI * 2) * 0.5
  const moonArcX = 0.5 + Math.sin((t - 0.5) * Math.PI * 2) * 0.5
  // Stars fade in as the sun drops below 0.18 altitude (well past dusk).
  const starOpacity = Math.max(0, 1 - sunAltitude / 0.18)
  // Period buckets. Split dusk/dawn by which half of the cycle we're
  // in — t<0.5 is the descending sun (afternoon → dusk), t≥0.5 is
  // ascending (dawn → morning).
  let period: TimeOfDayPeriod
  if (sunAltitude > 0.4) period = 'day'
  else if (sunAltitude > 0.02) period = t < 0.5 ? 'dusk' : 'dawn'
  else period = 'night'
  return {
    nightPhase,
    sunAltitude,
    moonAltitude,
    sunArcX,
    moonArcX,
    starOpacity,
    period,
  }
}
