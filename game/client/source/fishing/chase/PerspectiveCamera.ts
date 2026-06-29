/**
 * Legacy import path — all math lives in {@link Transform3D}.
 */
export {
  Transform3D,
  ChaseCamera3D,
  ChaseCamera3D as GoProCamera,
  penguinScreenPose,
  PENGUIN_MESH_SCALE,
  type ProjectedPoint,
  type CameraDynamics,
} from './Transform3D'

import { Transform3D } from './Transform3D'
import type { CameraDynamics, ProjectedPoint } from './Transform3D'
import { Vector3 } from './math/Vector3'

export interface PerspectiveConfig {
  width: number
  height: number
  vanishY: number
  judgeY: number
  skyJudgeY: number
  pitchDeg: number
  focalLength: number
  zPerBeat: number
  zFar: number
  fovExp: number
  nearXHalf: number
  skyLift: number
}

export type ProjectedScreen = ProjectedPoint

export function perspectiveConfigForViewport(w: number, h: number): PerspectiveConfig {
  const t = Transform3D.createForViewport(w, h)
  const judge = t.project(0, 0, Transform3D.Z_JUDGE)!
  const spawn = t.spawnScreen()!
  const sky = t.projectSkyPoint(0, 0.55, 0)!
  return {
    width: w,
    height: h,
    vanishY: spawn.y,
    judgeY: judge.y,
    skyJudgeY: sky?.y ?? judge.y - h * 0.2,
    pitchDeg: Transform3D.PITCH_DEG,
    focalLength: t.focalLength,
    zPerBeat: t.zSpeed,
    zFar: Transform3D.VISIBLE_BEATS,
    fovExp: 1,
    nearXHalf: 1,
    skyLift: t.skyHeight,
  }
}

export function projectGround(
  wx: number,
  beatAhead: number,
  transform: Transform3D,
  dyn: CameraDynamics,
): ProjectedPoint | null {
  return transform.projectGroundLane(wx, beatAhead, dyn)
}

export function projectSky(
  wx: number,
  wy: number,
  beatAhead: number,
  transform: Transform3D,
  dyn: CameraDynamics,
): ProjectedPoint | null {
  return transform.projectSkyPoint(wx, wy, beatAhead, dyn)
}

export function projectWorld(
  world: Vector3,
  transform: Transform3D,
  dyn: CameraDynamics,
): ProjectedPoint | null {
  return transform.projectVec(world, dyn)
}

export function beatToZ(beatAhead: number, transform: Transform3D): number {
  return transform.beatAheadToZ(beatAhead)
}

export function lateralHalfPx(transform: Transform3D, dyn: CameraDynamics): number {
  const p = transform.projectGroundLane(1, 0, dyn)
  if (!p) return transform.trackHalfWidth
  return Math.abs(p.x - transform.canvasWidth * 0.5)
}

export const PENGUIN_BODY_PX = 72

export function penguinChaseScreenPose(
  laneScreenX: number,
  _cfg: PerspectiveConfig,
  bank: number,
  tapPulse: number,
): { x: number; y: number; bank: number; scale: number } {
  void _cfg
  return { x: laneScreenX, y: 0, bank, scale: 0.5 * (1 + tapPulse * 0.04) }
}
