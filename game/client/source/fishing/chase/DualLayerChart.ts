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

/**
 * Call-and-response phrasing ("rhythmic breathing"). The two layers interlock
 * instead of running in parallel: while the sky arc is up the floor stays quiet
 * (just an apex-aligned accent), and where the sky RESTS the floor bursts — so
 * the finger pulls an air-slide, drops to tap the seabed, then a fresh reversed
 * arc lifts. Both layers are indexed by the same integer beat, so any sky apex
 * and the floor accent on that beat fire at the EXACT same targetMs.
 *
 * beat:  0     1      2     3     4     5     6      7
 * sky:   arc   APEX→  arc   rest  rest  arc   APEX← rest
 * floor: ·     tapR   ·     BURST BURST ·     tapL   BURST
 */

/** Ground layer — drum / bass (4-lane taps). */
export const DEFAULT_GROUND_CHART: GroundChartNode[] = [
  { type: 'rest', lane: 0 },
  { type: 'tap', lane: 3 }, // apex-right accent (sky beat 1) — right hand
  { type: 'rest', lane: 0 },
  { type: 'tap', lane: 0 }, // seabed burst while sky rests
  { type: 'tap', lane: 2 },
  { type: 'rest', lane: 0 },
  { type: 'tap', lane: 0 }, // apex-left accent (sky beat 6) — left hand
  { type: 'tap', lane: 3 }, // seabed burst while sky rests
]

/**
 * Sky layer — melody arcs (Catmull-Rom control points). `rest` beats break the
 * ribbon (it is neither drawn nor judged there), carving the phrase into two
 * short ~1.3–2s air-slides per bar with clear gaps for the floor burst.
 */
export const DEFAULT_SKY_CHART: SkyChartNode[] = [
  { type: 'tap', x: 0.0, y: 0.25 }, // arc rises, centre
  { type: 'hold', x: 0.8, y: 1.15 }, // APEX right
  { type: 'tap', x: 0.2, y: 0.5 }, // descend
  { type: 'rest', x: 0.0, y: 0.0 }, // BREAK (floor burst)
  { type: 'rest', x: 0.0, y: 0.0 }, // BREAK (floor burst)
  { type: 'tap', x: -0.2, y: 0.5 }, // reverse arc rises
  { type: 'hold', x: -0.8, y: 1.2 }, // APEX left
  { type: 'rest', x: 0.0, y: 0.1 }, // BREAK (settle)
]

// ---------------------------------------------------------------------------
// Dynamic difficulty director: chart evolves with SEA ZONE × CATCH RECORD
// ---------------------------------------------------------------------------

export interface DemoTrack {
  /** Linear, NON-looping sky nodes indexed by local beat (0 = fight start). */
  sky: SkyChartNode[]
  /** Linear, NON-looping ground nodes indexed by local beat. */
  ground: GroundChartNode[]
  /** Rare/Boss variant rolled from the player's success streak. */
  isBoss: boolean
}

const TOTAL_BEATS = 240

type Rng = () => number
function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const pick = (rand: Rng, arr: readonly number[]): number =>
  arr[Math.floor(rand() * arr.length) % arr.length]
const clampX = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x)

/**
 * Sea-zone → difficulty tier.
 *   0 = 海滩/浅海  (shallows, coast)   — 入门
 *   1 = 中深海/暗礁 (deep, abyss)      — 进阶复合
 *   2 = 远洋深渊   (abyssDeep)        — 终极高潮
 */
export function zoneTier(zone: number): 0 | 1 | 2 {
  if (zone <= 1) return 0
  if (zone <= 3) return 1
  return 2
}

/** 【入门】almost all green floor pearls + the occasional ~0.5s micro-slide. */
function buildEasyChart(sky: SkyChartNode[], ground: GroundChartNode[]): void {
  const lanes = [0, 2, 1, 3]
  for (let b = 0; b < TOTAL_BEATS; b++) {
    // Single pearl most beats; every 4th beat rests so it never doubles up.
    if (b % 4 !== 3) ground[b] = { type: 'tap', lane: lanes[b % lanes.length] }
  }
  // A gentle 1-beat air-slide every 8 beats, low and short.
  for (let base = 6; base + 1 < TOTAL_BEATS; base += 8) {
    const s = Math.floor(base / 8) % 2 === 0 ? -1 : 1
    sky[base] = { type: 'tap', x: s * 0.22, y: 0.32 }
    sky[base + 1] = { type: 'tap', x: s * 0.4, y: 0.42 }
  }
}

/** 【进阶复合】~1.5s mid slides; the slide's release interlocks with an
 *  opposite-hand floor pearl (left-air ↔ right-floor). */
function buildMediumChart(sky: SkyChartNode[], ground: GroundChartNode[]): void {
  let side = -1
  for (let b = 0; b + 4 < TOTAL_BEATS; b += 5) {
    const s = side
    sky[b] = { type: 'tap', x: s * 0.4, y: 0.45 }
    sky[b + 1] = { type: 'hold', x: s * 0.72, y: 0.78 } // ~2-beat mid slide
    sky[b + 2] = { type: 'tap', x: s * 0.4, y: 0.5 }
    const oppFar = s < 0 ? 3 : 0
    const oppNear = s < 0 ? 2 : 1
    // Release-instant interlock + breathing gap of opposite-hand floor taps.
    ground[b + 2] = { type: 'tap', lane: oppFar }
    ground[b + 3] = { type: 'tap', lane: oppNear }
    ground[b + 4] = { type: 'tap', lane: oppFar }
    side = -side
  }
}

/** 【终极高潮】full-screen 4s+ Catmull-Rom long slides; while the slide is
 *  energised, floor pearls machine-gun the OPPOSITE lanes ("pearl sandwich"). */
function buildClimaxChart(
  sky: SkyChartNode[],
  ground: GroundChartNode[],
  rand: Rng,
  isBoss: boolean,
): void {
  const amp = isBoss ? 1.0 : 0.9
  // 16-beat super-phrase: 8-beat grand arc, 2-beat breath, 6-beat reverse arc.
  const superArc: Array<{ type: LayerNoteKind; x: number; y: number } | null> = [
    { type: 'tap', x: 0.0, y: 0.5 },
    { type: 'hold', x: 0.9, y: 1.15 },
    { type: 'hold', x: 0.35, y: 0.7 },
    { type: 'hold', x: -0.95, y: 1.3 }, // grand cross apex
    { type: 'hold', x: -0.3, y: 0.6 },
    { type: 'hold', x: 0.6, y: 1.05 },
    { type: 'hold', x: 0.9, y: 0.5 },
    { type: 'tap', x: 0.2, y: 0.4 },
    null, // breath
    null, // breath
    { type: 'tap', x: -0.5, y: 0.5 },
    { type: 'hold', x: -0.95, y: 1.2 },
    { type: 'hold', x: 0.0, y: 0.75 },
    { type: 'hold', x: 0.95, y: 1.28 }, // grand cross apex
    { type: 'hold', x: 0.3, y: 0.6 },
    { type: 'tap', x: -0.4, y: 0.4 },
  ]
  const heavy = new Set([3, 13]) // gravity turns → floor HOLD accent
  for (let b = 0; b < TOTAL_BEATS; b++) {
    const k = b % 16
    const node = superArc[k]
    const arcX = node ? node.x : 0
    if (node) sky[b] = { type: node.type, x: clampX(node.x * amp), y: node.y }
    // Pearl-sandwich: hammer the lanes OPPOSITE the current slide side. The
    // per-beat grid is the densest the scheduler allows (true sub-beat 0.25s
    // pearls would need a fractional-beat note model).
    const lanes = arcX >= 0 ? [0, 1] : [2, 3]
    ground[b] = { type: heavy.has(k) ? 'hold' : 'tap', lane: pick(rand, lanes) }
  }
}

/**
 * Build a whole battle chart whose character is decided by the sea zone the
 * hook was dropped in and the player's cumulative catch record. Deeper zones =
 * harder charts; a long success streak can roll a rare/Boss variant.
 */
export function generateDemoTrack(zone = 0, successCount = 0): DemoTrack {
  const sky: SkyChartNode[] = []
  const ground: GroundChartNode[] = []
  for (let i = 0; i < TOTAL_BEATS; i++) {
    sky.push({ type: 'rest', x: 0, y: 0 })
    ground.push({ type: 'rest', lane: 0 })
  }

  // Structure is deterministic per (zone, record); the Boss roll is live-random.
  const rand = makeRng((0x9e3779b9 ^ (zone * 0x9e37) ^ (successCount * 0x85eb)) >>> 0)
  const isBoss = successCount > 10 && Math.random() > 0.4

  const tier = zoneTier(zone)
  if (tier === 0) buildEasyChart(sky, ground)
  else if (tier === 1) buildMediumChart(sky, ground)
  else buildClimaxChart(sky, ground, rand, isBoss)

  return { sky, ground, isBoss }
}

/** Default chart for module init (regenerated per battle by BattleState). */
export const DEMO_TRACK: DemoTrack = generateDemoTrack(0, 0)
