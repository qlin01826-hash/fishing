import type { Vector3 } from './math/Vector3'

export type ChartNodeKind = 'apex' | 'rest'

export interface TrackChartNode {
  type: ChartNodeKind
  /** Lateral offset on the racing line (-1..1). */
  x: number
  /** Vertical carve amplitude (world units). */
  y: number
}

export interface ITrackSplineProvider {
  /** Sample the volumetric racing line in native 3D space. */
  getTrackPoints(currentTimeBeats: number, stepBeats?: number): Vector3[]
  /** Forward-facing unit tangent at `currentTimeBeats`. */
  getTangentAtTime(currentTimeBeats: number): Vector3
  /** Lateral requirement at the current downbeat (aim hint). */
  getRequiredLxAtTime(currentTimeBeats: number): number
  /** Node at integer beat (apex = action, rest = fish escort gap). */
  getNodeAtBeat(beat: number): TrackChartNode
  /** True when fish should escort rather than evacuate. */
  isRestPhaseAtBeat(beat: number): boolean
}

export type RenderEntityType = 'Penguin' | 'BeatNode' | 'FishSwarm'
export type VisualEffectType = 'VortexBurst' | 'WaterSplash'
export type EnvironmentFlowState = 'Gaps_Escort' | 'Beat_Evacuation'

export interface IRenderBridge {
  createRenderEntity(type: RenderEntityType, id: string): void
  updateEntityTransform(id: string, position: Vector3, rotation: import('./math/Vector3').Euler3, scale: Vector3): void
  triggerVisualEffect(id: string, effectType: VisualEffectType): void
  setEnvironmentFlowState(state: EnvironmentFlowState, intensity: number): void
  setLayout(width: number, height: number): void
  setActive(active: boolean): void
  update(dtSeconds: number, nowMs: number, scrollBeats: number): void
  getPenguinScreenPose(): { x: number; y: number; bank: number; scale: number }
  aimAtScreenX(screenX: number): void
  setFishTint(color: number): void
}
