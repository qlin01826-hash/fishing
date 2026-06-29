import type { ITrackSplineProvider, TrackChartNode } from './ITrackSplineProvider'
import {
  BEATS_PER_BAR,
  DEFAULT_GROUND_CHART,
  DEFAULT_SKY_CHART,
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

function smootherstep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

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
  private readonly groundChart: GroundChartNode[]
  private readonly skyChart: SkyChartNode[]
  private transform: Transform3D
  private readonly _tangent = new Vector3()

  constructor(
    skyChart: SkyChartNode[] = DEFAULT_SKY_CHART,
    transform: Transform3D,
    groundChart: GroundChartNode[] = DEFAULT_GROUND_CHART,
  ) {
    this.skyChart = skyChart
    this.groundChart = groundChart
    this.transform = transform
  }

  setTransform(transform: Transform3D): void {
    this.transform = transform
  }

  /** @deprecated */ setConfig(cfg: unknown): void {
    void cfg
  }

  get transform3D(): Transform3D {
    return this.transform
  }

  getGroundNodeAtBeat(beat: number): GroundChartNode {
    const i = ((Math.floor(beat) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
    return this.groundChart[i]
  }

  getSkyNodeAtBeat(beat: number): SkyChartNode {
    const i = ((Math.floor(beat) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
    return this.skyChart[i]
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
    const u = ((beats / BEATS_PER_BAR) % 1 + 1) % 1
    const s = u * BEATS_PER_BAR
    const i = Math.floor(s) % BEATS_PER_BAR
    const f = smootherstep(s - Math.floor(s))
    const im = (i - 1 + BEATS_PER_BAR) % BEATS_PER_BAR
    const ip = (i + 1) % BEATS_PER_BAR
    const i2 = (i + 2) % BEATS_PER_BAR
    const pts = [this.skyChart[im], this.skyChart[i], this.skyChart[ip], this.skyChart[i2]]
    return {
      x: cr(pts[0].x, pts[1].x, pts[2].x, pts[3].x, f),
      y: cr(pts[0].y, pts[1].y, pts[2].y, pts[3].y, f),
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
