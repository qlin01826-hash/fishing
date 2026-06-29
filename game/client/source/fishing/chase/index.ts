export { Vector3, type Euler3 } from './math/Vector3'
export type {
  ITrackSplineProvider,
  IRenderBridge,
  TrackChartNode,
  ChartNodeKind,
  RenderEntityType,
  VisualEffectType,
  EnvironmentFlowState,
} from './ITrackSplineProvider'
export {
  Transform3D,
  ChaseCamera3D,
  penguinScreenPose,
  PENGUIN_MESH_SCALE,
  type ProjectedPoint,
  type CameraDynamics,
} from './Transform3D'
export {
  perspectiveConfigForViewport,
  projectGround,
  projectSky,
  projectWorld,
  lateralHalfPx,
  beatToZ,
  GoProCamera,
  type PerspectiveConfig,
  type ProjectedScreen,
} from './PerspectiveCamera'
export {
  LANE_X,
  BEATS_PER_BAR as CHART_BEATS_PER_BAR,
  DEFAULT_GROUND_CHART,
  DEFAULT_SKY_CHART,
  type GroundChartNode,
  type SkyChartNode,
} from './DualLayerChart'
export {
  TrackSplineProvider,
  DEFAULT_CHASE_CHART,
  BEATS_PER_BAR as CHASE_BEATS_PER_BAR,
} from './TrackSplineProvider'
export { PixiRenderBridge } from './PixiRenderBridge'
export { BoidsFishSwarm } from './BoidsFishSwarm'
export { GameStateController, GameRenderMode } from './GameStateController'
export { orientationFromTangent } from './ChaseKinematics'
