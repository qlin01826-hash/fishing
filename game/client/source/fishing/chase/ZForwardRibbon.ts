import type { CameraDynamics, ProjectedPoint, Transform3D } from './Transform3D'
import type { TrackSplineProvider } from './TrackSplineProvider'

/** Base Z-axis slice step for ribbon mesh near the camera (world units). */
export const RIBBON_STEP_Z = 15

/**
 * Adaptive depth stepping: slices stay dense near the judge plane (where the
 * track fills the screen and curvature matters) and grow with depth, since the
 * far field is perspective-compressed into a few pixels. This roughly halves
 * the slice/projection/spline-sample count vs. a fixed step with no visible
 * loss of fidelity — a big GC + fill-rate win, especially on tall phones.
 */
export function zSliceStep(worldZ: number, zMax: number): number {
  return RIBBON_STEP_Z * (1 + (worldZ / zMax) * 2.5)
}

/** One cross-section of the track at a fixed world Z. */
export interface TrackCrossSection {
  worldZ: number
  centerX: number
  worldY: number
  /** Half-width in world metres — constant in 3D; perspective collapses on screen. */
  halfWidth: number
  skyThick: number
  fog: number
  isHold: boolean
  /** Sky beat here is a rest — ribbon should break (not be drawn/judged). */
  isRest: boolean
  /** A floor note occupies this beat — sky slice can occlude it from view. */
  floorBehind: boolean
}

/** Projected quad strip connecting two adjacent Z slices. */
export interface RibbonQuad {
  worldZ: number
  bl: ProjectedPoint
  br: ProjectedPoint
  tl: ProjectedPoint
  tr: ProjectedPoint
  isHold: boolean
  isRest: boolean
  floorBehind: boolean
  fog: number
}

/**
 * Wave propagates along +Z (depth), not lateral screen X.
 */
export function waveOffsetX(worldZ: number, ribbonTime: number, trackHalfWidth: number): number {
  return Math.sin(worldZ * 0.005 - ribbonTime * 2.4) * trackHalfWidth * 0.04
}

/**
 * Map chart Y (0..~1.5) to world height — delegates to {@link Transform3D}.
 */
export function skyChartYToWorldY(chartY: number, transform: Transform3D): number {
  return transform.skyChartYToWorldY(chartY)
}

/** Sky-track centre in world space at a fixed Z slice. */
export function skyTrackCenterWorld(
  scroll: number,
  track: TrackSplineProvider,
  transform: Transform3D,
  ribbonTime: number,
  worldZ: number,
): { worldX: number; worldY: number } {
  const beatAhead = transform.zToBeatAhead(worldZ)
  const sky = track.skyAtBeat(scroll + beatAhead)
  const wave = waveOffsetX(worldZ, ribbonTime, transform.trackHalfWidth)
  return {
    worldX: sky.x * transform.trackHalfWidth + wave,
    worldY: transform.skyChartYToWorldY(sky.y),
  }
}

export function buildCrossSections(
  transform: Transform3D,
  track: TrackSplineProvider,
  scroll: number,
  ribbonTime: number,
  kind: 'ground' | 'sky',
): TrackCrossSection[] {
  const zMax = transform.zSpawn
  const out: TrackCrossSection[] = []

  for (let worldZ = 0; worldZ <= zMax; worldZ += zSliceStep(worldZ, zMax)) {
    const beatAhead = transform.zToBeatAhead(worldZ)
    const beat = scroll + beatAhead
    const sky = track.skyAtBeat(beat)
    const wave = waveOffsetX(worldZ, ribbonTime, transform.trackHalfWidth)
    const centerX = sky.x * transform.trackHalfWidth + wave
    const fog = Math.pow(Math.min(1, worldZ / transform.zSpawn), 1.25)
    const node = track.getSkyNodeAtBeat(Math.floor(beat))

    if (kind === 'ground') {
      out.push({
        worldZ,
        centerX,
        worldY: 0,
        halfWidth: transform.trackHalfWidth * 1.02,
        skyThick: 0,
        fog,
        isHold: false,
        isRest: false,
        floorBehind: false,
      })
    } else {
      const worldY = transform.skyChartYToWorldY(sky.y)
      const ground = track.getGroundNodeAtBeat(Math.floor(beat))
      // Near slices physically swell so the approaching head reads as a thick
      // breaking wave; far slices stay thin so the depth gradient is legible.
      const headBoost = 1 + Math.max(0, 1 - worldZ / (zMax * 0.16)) * 1.2
      out.push({
        worldZ,
        centerX,
        worldY,
        halfWidth: transform.trackHalfWidth * 0.19 * headBoost,
        skyThick: transform.skyHeight * 0.11 * headBoost,
        fog,
        isHold: node.type === 'hold',
        isRest: node.type === 'rest',
        floorBehind: ground.type !== 'rest',
      })
    }
  }

  return out
}

export function crossSectionsToQuads(
  sections: TrackCrossSection[],
  transform: Transform3D,
  dyn: CameraDynamics,
  skyBand: boolean,
): RibbonQuad[] {
  const quads: RibbonQuad[] = []

  for (let i = 0; i < sections.length - 1; i++) {
    const near = sections[i]
    const far = sections[i + 1]
    const worldZ = (near.worldZ + far.worldZ) * 0.5

    if (skyBand) {
      const nbl = transform.project(near.centerX - near.halfWidth, near.worldY - near.skyThick, near.worldZ, dyn)
      const nbr = transform.project(near.centerX + near.halfWidth, near.worldY - near.skyThick, near.worldZ, dyn)
      const ntl = transform.project(near.centerX - near.halfWidth, near.worldY + near.skyThick, near.worldZ, dyn)
      const ntr = transform.project(near.centerX + near.halfWidth, near.worldY + near.skyThick, near.worldZ, dyn)
      const fbl = transform.project(far.centerX - far.halfWidth, far.worldY - far.skyThick, far.worldZ, dyn)
      const fbr = transform.project(far.centerX + far.halfWidth, far.worldY - far.skyThick, far.worldZ, dyn)
      const ftl = transform.project(far.centerX - far.halfWidth, far.worldY + far.skyThick, far.worldZ, dyn)
      const ftr = transform.project(far.centerX + far.halfWidth, far.worldY + far.skyThick, far.worldZ, dyn)
      if (!nbl || !nbr || !ntl || !ntr || !fbl || !fbr || !ftl || !ftr) continue

      quads.push({
        worldZ,
        bl: fbl,
        br: fbr,
        tl: ftl,
        tr: ftr,
        isHold: near.isHold || far.isHold,
        isRest: near.isRest || far.isRest,
        floorBehind: near.floorBehind || far.floorBehind,
        fog: (near.fog + far.fog) * 0.5,
      })
    } else {
      const nl = transform.project(near.centerX - near.halfWidth, near.worldY, near.worldZ, dyn)
      const nr = transform.project(near.centerX + near.halfWidth, near.worldY, near.worldZ, dyn)
      const fl = transform.project(far.centerX - far.halfWidth, far.worldY, far.worldZ, dyn)
      const fr = transform.project(far.centerX + far.halfWidth, far.worldY, far.worldZ, dyn)
      if (!nl || !nr || !fl || !fr) continue

      quads.push({
        worldZ,
        bl: fl,
        br: fr,
        tl: nl,
        tr: nr,
        isHold: false,
        isRest: false,
        floorBehind: false,
        fog: (near.fog + far.fog) * 0.5,
      })
    }
  }

  return quads
}

export function drawRibbonQuad(
  g: import('pixi.js').Graphics,
  q: RibbonQuad,
  fillColor: number,
  fillAlpha: number,
  strokeColor: number,
  strokeAlpha: number,
  strokeScale: number,
): void {
  g.moveTo(q.tl.x, q.tl.y)
  g.lineTo(q.tr.x, q.tr.y)
  g.lineTo(q.br.x, q.br.y)
  g.lineTo(q.bl.x, q.bl.y)
  g.closePath()
  g.fill({ color: fillColor, alpha: fillAlpha * (1 - q.fog * 0.55) })

  g.moveTo(q.tl.x, q.tl.y)
  g.lineTo(q.tr.x, q.tr.y)
  g.stroke({
    color: strokeColor,
    width: Math.max(0.8, 2.2 * strokeScale),
    alpha: strokeAlpha * (1 - q.fog * 0.4),
    cap: 'round',
    join: 'round',
  })
}
