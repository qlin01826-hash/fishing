import type { ITrackSplineProvider, TrackChartNode } from './ITrackSplineProvider'
import {
  BEATS_PER_BAR,
  DEFAULT_GROUND_CHART,
  DEFAULT_SKY_CHART,
  DEMO_TRACK,
  LANE_X,
  type GroundChartNode,
  type SkyChartNode,
} from './DualLayerChart'
import { Vector3 } from './math/Vector3'
import { Transform3D } from './Transform3D'

export { BEATS_PER_BAR, DEFAULT_GROUND_CHART, DEFAULT_SKY_CHART, LANE_X }

export const DEFAULT_CHASE_CHART: TrackChartNode[] = DEFAULT_SKY_CHART.map((n) => ({
  type: n.type === 'rest' ? 'rest' : 'apex',
  x: n.x,
  y: n.y,
}))

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

/**
 * Native 3D track data — all positions in world (X,Y,Z) before {@link Transform3D}.
 */
export class TrackSplineProvider implements ITrackSplineProvider {
  private groundChart: GroundChartNode[]
  private skyChart: SkyChartNode[]
  private transform: Transform3D
  private readonly _tangent = new Vector3()
  /**
   * Absolute beat that maps to LOCAL beat 0 of the linear chart. Captured when
   * a fight begins so the three-stage timeline (intro → develop → climax)
   * always starts fresh from the moment the chase opens.
   */
  private startBeat = 0

  constructor(
    skyChart: SkyChartNode[] = DEMO_TRACK.sky,
    transform: Transform3D,
    groundChart: GroundChartNode[] = DEMO_TRACK.ground,
  ) {
    this.skyChart = skyChart
    this.groundChart = groundChart
    this.transform = transform
  }

  setTransform(transform: Transform3D): void {
    this.transform = transform
  }

  /** Swap in a freshly generated chart (per-battle difficulty director). */
  setCharts(skyChart: SkyChartNode[], groundChart: GroundChartNode[]): void {
    this.skyChart = skyChart
    this.groundChart = groundChart
  }

  /** Anchor the linear chart so LOCAL beat 0 == this absolute beat. */
  setStartBeat(beat: number): void {
    this.startBeat = Math.floor(beat)
  }

  /** Absolute beat → clamped local chart index (no looping; holds the ends). */
  private localIndex(beat: number): number {
    const l = Math.floor(beat) - this.startBeat
    if (l < 0) return 0
    const max = this.skyChart.length - 1
    return l > max ? max : l
  }

  get transform3DRef(): Transform3D {
    return this.transform
  }

  /** @deprecated */ setConfig(cfg: unknown): void {
    void cfg
  }

  get transform3D(): Transform3D {
    return this.transform
  }

  getGroundNodeAtBeat(beat: number): GroundChartNode {
    return this.groundChart[this.localIndex(beat)]
  }

  getSkyNodeAtBeat(beat: number): SkyChartNode {
    return this.skyChart[this.localIndex(beat)]
  }

  getNodeAtBeat(beat: number): TrackChartNode {
    const s = this.getSkyNodeAtBeat(beat)
    return { type: s.type === 'rest' ? 'rest' : 'apex', x: s.x, y: s.y }
  }

  isRestPhaseAtBeat(beat: number): boolean {
    const g = this.getGroundNodeAtBeat(beat)
    const s = this.getSkyNodeAtBeat(beat)
    return g.type === 'rest' && s.type === 'rest'
  }

  getRequiredLxAtTime(currentTimeBeats: number): number {
    return this.skyAtBeat(currentTimeBeats).x
  }

  skyAtBeat(beats: number): { x: number; y: number } {
    const len = this.skyChart.length
    // Linear (non-looping) local position along the whole level timeline.
    const local = beats - this.startBeat
    const c = local < 0 ? 0 : local > len - 1 - 1e-4 ? len - 1 - 1e-4 : local
    const i = Math.floor(c)
    // UNIFORM parameter (not eased): the 4-point Catmull-Rom below already gives
    // a silk-smooth C1 path; warping `f` with smootherstep would force velocity
    // to 0 at every node and lurch between them ("transition too fast / rigid").
    const f = c - i
    // Clamp neighbour indices to the array bounds (hold the ends — no wrap seam).
    const im = i - 1 < 0 ? 0 : i - 1
    const ip = i + 1 > len - 1 ? len - 1 : i + 1
    const i2 = i + 2 > len - 1 ? len - 1 : i + 2
    const p0 = this.skyChart[im]
    const p1 = this.skyChart[i]
    const p2 = this.skyChart[ip]
    const p3 = this.skyChart[i2]
    return {
      x: cr(p0.x, p1.x, p2.x, p3.x, f),
      y: cr(p0.y, p1.y, p2.y, p3.y, f),
    }
  }

  groundWorldAtBeat(beats: number, scrollBeats: number): Vector3 {
    const lane = LANE_X[Math.max(0, Math.min(3, this.getGroundNodeAtBeat(beats).lane))] ?? 0
    const beatAhead = beats - scrollBeats
    return new Vector3(
      lane * this.transform.trackHalfWidth,
      0,
      this.transform.beatAheadToZ(beatAhead),
    )
  }

  skyWorldAtBeat(beats: number, scrollBeats: number): Vector3 {
    const s = this.skyAtBeat(beats)
    const beatAhead = beats - scrollBeats
    return new Vector3(
      s.x * this.transform.trackHalfWidth,
      this.transform.skyChartYToWorldY(s.y),
      this.transform.beatAheadToZ(beatAhead),
    )
  }

  getTangentAtTime(currentTimeBeats: number): Vector3 {
    const e = 0.04
    const a = this.skyWorldAtBeat(currentTimeBeats - e, currentTimeBeats)
    const b = this.skyWorldAtBeat(currentTimeBeats + e, currentTimeBeats)
    this._tangent.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize()
    return this._tangent
  }

  worldAtBeat(beats: number, scrollBeats: number): Vector3 {
    return this.skyWorldAtBeat(beats, scrollBeats)
  }

  getTrackPoints(currentTimeBeats: number, stepBeats = 0.5): Vector3[] {
    const out: Vector3[] = []
    for (let ba = 0.25; ba <= Transform3D.VISIBLE_BEATS; ba += stepBeats) {
      out.push(this.skyWorldAtBeat(currentTimeBeats + ba, currentTimeBeats))
    }
    return out
  }
}
