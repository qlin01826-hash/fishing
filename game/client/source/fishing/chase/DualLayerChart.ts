/** Arcaea-style dual-layer chart data (decoupled from rendering). */

export type LayerNoteKind = 'tap' | 'hold' | 'rest'

export interface GroundChartNode {
  type: LayerNoteKind
  /** Lane index 0..3 (left → right). */
  lane: number
}

export interface SkyChartNode {
  type: LayerNoteKind
  /** Lateral offset on sky arc (-1..1). */
  x: number
  /** Vertical arc amplitude (sky space, 0..1.5). */
  y: number
}

export const LANE_X = [-0.92, -0.31, 0.31, 0.92] as const
export const BEATS_PER_BAR = 8

/** Ground layer — drum / bass (4-lane taps). */
export const DEFAULT_GROUND_CHART: GroundChartNode[] = [
  { type: 'tap', lane: 1 },
  { type: 'tap', lane: 2 },
  { type: 'hold', lane: 2 },
  { type: 'rest', lane: 1 },
  { type: 'tap', lane: 3 },
  { type: 'tap', lane: 0 },
  { type: 'hold', lane: 1 },
  { type: 'tap', lane: 2 },
]

/** Sky layer — melody arcs (Catmull-Rom control points). */
export const DEFAULT_SKY_CHART: SkyChartNode[] = [
  { type: 'tap', x: 0, y: 0.2 },
  { type: 'hold', x: 0.75, y: 1.2 },
  { type: 'hold', x: 0.4, y: 0.55 },
  { type: 'tap', x: -0.2, y: 0.65 },
  { type: 'hold', x: -0.68, y: 1.25 },
  { type: 'tap', x: -0.85, y: 0.35 },
  { type: 'hold', x: -0.35, y: 0.95 },
  { type: 'tap', x: 0.45, y: 0.25 },
]
