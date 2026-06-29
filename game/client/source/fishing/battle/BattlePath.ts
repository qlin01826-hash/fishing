/**
 * Legacy battle-path helpers — gameplay states still import from here.
 * Core 3D spline + projection live under `chase/`.
 */
import { perspectiveConfigForViewport } from '../chase/PerspectiveCamera'
import { Transform3D } from '../chase/Transform3D'
import { DEFAULT_SKY_CHART, TrackSplineProvider } from '../chase/TrackSplineProvider'

export type ChartNodeType = 'tap' | 'hold'

export interface ChartNode {
  type: ChartNodeType
  lx: number
  y: number
}

export const BEATS_PER_BAR = 8
export const U_PER_BEAT = 1 / BEATS_PER_BAR

export const DEMO_CHART: ChartNode[] = [
  { type: 'tap', lx: 0, y: -1.1 },
  { type: 'hold', lx: 0.35, y: -1.9 },
  { type: 'hold', lx: 0.72, y: -1.4 },
  { type: 'tap', lx: 0.85, y: 0.35 },
  { type: 'hold', lx: 0.55, y: 0.75 },
  { type: 'tap', lx: -0.15, y: -0.2 },
  { type: 'hold', lx: -0.68, y: -1.3 },
  { type: 'tap', lx: -0.82, y: 0.25 },
]

export interface ChaseProjection {
  cx: number
  horizon: number
  judgeY: number
  lateralPix: number
  coasterAmp: number
  depthMul: number
  visibleBeats: number
}

export interface PathPoint {
  x: number
  y: number
}

export interface ChaseCamera {
  pitch: number
  bank: number
  depthY: number
  beatFrac: number
  scrollBeats: number
}

export interface ProjectedPoint {
  x: number
  y: number
  s: number
  aheadBeats: number
}

let sharedTrack: TrackSplineProvider | null = null

function getSharedTrack(w: number, h: number): TrackSplineProvider {
  const transform = Transform3D.createForViewport(w, h)
  if (!sharedTrack) {
    sharedTrack = new TrackSplineProvider(DEFAULT_SKY_CHART, transform)
  } else {
    sharedTrack.setTransform(transform)
  }
  return sharedTrack
}

export function chaseProjectionForViewport(w: number, h: number): ChaseProjection {
  const cfg = perspectiveConfigForViewport(w, h)
  const landscape = w >= h
  return {
    cx: w * 0.5,
    horizon: cfg.vanishY,
    judgeY: cfg.judgeY,
    lateralPix: cfg.nearXHalf * 28,
    coasterAmp: h * (landscape ? 0.14 : 0.12),
    depthMul: 3.4,
    visibleBeats: cfg.zFar,
  }
}

function smootherstep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * x * (x * (x * 6 - 15) + 10)
}

function wrap01(v: number): number {
  v = v % 1
  return v < 0 ? v + 1 : v
}

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  )
}

export function beatToU(beats: number): number {
  return wrap01(beats / BEATS_PER_BAR)
}

export function pathAtU(u: number, chart: ChartNode[] = DEMO_CHART): PathPoint {
  const s = u * BEATS_PER_BAR
  const i = Math.floor(s) % BEATS_PER_BAR
  const f = smootherstep(s - Math.floor(s))
  const im = (i - 1 + BEATS_PER_BAR) % BEATS_PER_BAR
  const ip = (i + 1) % BEATS_PER_BAR
  const i2 = (i + 2) % BEATS_PER_BAR
  const pts = [chart[im], chart[i], chart[ip], chart[i2]]
  return {
    x: cr(pts[0].lx, pts[1].lx, pts[2].lx, pts[3].lx, f),
    y: cr(pts[0].y, pts[1].y, pts[2].y, pts[3].y, f),
  }
}

export function pathAtBeat(beats: number, chart?: ChartNode[]): PathPoint {
  return pathAtU(beatToU(beats), chart)
}

export function chartEntryAtBeat(b: number, chart: ChartNode[] = DEMO_CHART): ChartNode {
  const i = ((Math.floor(b) % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR
  return chart[i]
}

export class BattlePathCamera {
  private smoothPitch = 0
  private smoothBank = 0
  private readonly camLerp = 0.06

  reset(): void {
    this.smoothPitch = 0
    this.smoothBank = 0
  }

  update(scrollBeats: number, chart: ChartNode[] = DEMO_CHART): ChaseCamera {
    const u = beatToU(scrollBeats)
    const pos = pathAtU(u, chart)
    const e = 0.012
    const a = pathAtU(wrap01(u - e), chart)
    const b = pathAtU(wrap01(u + e), chart)
    const pitchTarget = Math.atan2(b.y - a.y, 0.6) * 0.28
    const bankTarget = Math.max(-0.18, Math.min(0.18, -(b.x - a.x) * 0.35))
    this.smoothPitch += (pitchTarget - this.smoothPitch) * this.camLerp
    this.smoothBank += (bankTarget - this.smoothBank) * this.camLerp
    return {
      pitch: this.smoothPitch,
      bank: this.smoothBank,
      depthY: pos.y,
      beatFrac: scrollBeats - Math.floor(scrollBeats),
      scrollBeats,
    }
  }
}

export function requiredLxAtScroll(scrollBeats: number, _chart?: ChartNode[]): number {
  return getSharedTrack(844, 390).getRequiredLxAtTime(scrollBeats)
}

export function screenXToLx(screenX: number, proj: ChaseProjection): number {
  return Math.max(-1.05, Math.min(1.05, (screenX - proj.cx) / proj.lateralPix))
}

export function projectPlayerLx(lx: number, proj: ChaseProjection): { x: number; y: number } {
  return { x: proj.cx + lx * proj.lateralPix, y: proj.judgeY }
}

export function approachT(aheadBeats: number, proj: ChaseProjection): number {
  const ab = Math.max(0, aheadBeats)
  return Math.max(0, 1 - ab / proj.visibleBeats)
}

function scaleZ(aheadBeats: number, depthMul: number): number {
  return 1 / (1 + Math.max(0.03, aheadBeats) * depthMul)
}

export function projectFloor(
  wx: number,
  aheadBeats: number,
  proj: ChaseProjection,
): ProjectedPoint {
  const ab = Math.max(0, aheadBeats)
  const s = scaleZ(ab, proj.depthMul)
  const t = approachT(ab, proj)
  const groundY = proj.horizon + (proj.judgeY + 6 - proj.horizon) * t
  return { x: proj.cx + wx * proj.lateralPix * s, y: groundY, s, aheadBeats: ab }
}

export function projectSkyRail(
  wx: number,
  wy: number,
  aheadBeats: number,
  cam: ChaseCamera,
  proj: ChaseProjection,
): ProjectedPoint {
  const ab = Math.max(0, aheadBeats)
  const s = scaleZ(ab, proj.depthMul)
  const t = approachT(ab, proj)
  const baseY = proj.horizon + (proj.judgeY - proj.horizon) * t
  const arc = -wy * proj.coasterAmp * t * (1 - t) * 4
  return {
    x: proj.cx + wx * proj.lateralPix * s + Math.sin(cam.bank) * 10 * (1 - t),
    y: baseY + arc + Math.sin(cam.pitch) * 10 * (1 - t),
    s,
    aheadBeats: ab,
  }
}
