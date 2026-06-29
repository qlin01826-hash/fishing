import { Vector3 } from './math/Vector3'

/** Screen-space result after perspective divide + optional camera dynamics. */
export interface ProjectedPoint {
  x: number
  y: number
  /** Inverse-depth scale = focalLength / rotZ (NOT linear). */
  scale: number
  /** Depth after pitch rotation — used for sorting & fog. */
  rotZ: number
  worldZ: number
  fog: number
}

/** Runtime camera shake / bank layered on top of the static pitch camera. */
export interface CameraDynamics {
  bank: number
  offsetX: number
  offsetY: number
  shake: number
}

const DEG = Math.PI / 180

/** Responsive viewport profile — recomputed on every resize. */
export interface ViewportProjectionProfile {
  isPortrait: boolean
  focalLength: number
  vanishingCy: number
  zSpawn: number
}

/**
 * True 3D perspective engine for Canvas2D.
 *
 * World axes:
 * - X: lateral (0 = track centre)
 * - Y: height (0 = seafloor)
 * - Z: depth timeline (0 = judgement, zSpawn = far horizon)
 *
 * Focal length, vanishing height, and Z span adapt to portrait vs landscape.
 * Camera Z is auto-calibrated per resize so the judge line sits in the lower
 * golden zone on phones while the spawn horizon stays in the upper third.
 */
export class Transform3D {
  static readonly Z_JUDGE = 0
  /** Penguin rides just ahead of the judge plane in chase view. */
  static readonly PENGUIN_CHASE_Z = 25
  static readonly VISIBLE_BEATS = 24
  static readonly Z_SPAWN_LANDSCAPE = 1200
  static readonly Z_SPAWN_PORTRAIT = 1600
  /** Multiplier on beat→Z mapping — spreads notes along the depth highway. */
  static readonly Z_SPACING_MUL = 3.5

  static readonly FOV_DEG = 75
  static readonly CAMERA_Y = 140
  /** Nominal camera retreat — {@link calibrateForViewport} may nudge per aspect. */
  static readonly CAMERA_Z = -40
  static readonly PITCH_DEG = 10

  fovDeg = Transform3D.FOV_DEG
  focalLength = 300
  cameraY = Transform3D.CAMERA_Y
  cameraZ = Transform3D.CAMERA_Z
  pitchRad = Transform3D.PITCH_DEG * DEG

  canvasWidth = 844
  canvasHeight = 390

  zSpawn = Transform3D.Z_SPAWN_LANDSCAPE
  vanishingPointYRatio = 0.35
  /** Flip screen-Y so Z=0 (judge) maps toward the bottom of the screen. */
  screenYInverted = true

  trackHalfWidth = 210
  skyHeight = 250
  zSpeed = Transform3D.Z_SPAWN_LANDSCAPE / Transform3D.VISIBLE_BEATS
  zSpacingMul = Transform3D.Z_SPACING_MUL

  private cosP = Math.cos(Transform3D.PITCH_DEG * DEG)
  private sinP = Math.sin(Transform3D.PITCH_DEG * DEG)

  /** @deprecated Use instance {@link zSpawn}. */
  static get Z_SPAWN(): number {
    return Transform3D.Z_SPAWN_LANDSCAPE
  }

  static createForViewport(width: number, height: number): Transform3D {
    const t = new Transform3D()
    t.canvasWidth = width
    t.canvasHeight = height
    t.calibrateForViewport()
    return t
  }

  get isPortrait(): boolean {
    return this.canvasHeight > this.canvasWidth
  }

  buildProjectionProfile(
    canvasWidth = this.canvasWidth,
    canvasHeight = this.canvasHeight,
  ): ViewportProjectionProfile {
    const isPortrait = canvasHeight > canvasWidth
    return {
      isPortrait,
      focalLength: isPortrait ? canvasWidth * 0.8 : canvasHeight * 0.6,
      vanishingCy: canvasHeight * (isPortrait ? 0.3 : 0.35),
      zSpawn: isPortrait ? Transform3D.Z_SPAWN_PORTRAIT : Transform3D.Z_SPAWN_LANDSCAPE,
    }
  }

  private applyProjectionProfile(profile: ViewportProjectionProfile): void {
    this.focalLength = profile.focalLength
    this.vanishingPointYRatio = profile.vanishingCy / Math.max(1, this.canvasHeight)
    this.zSpawn = profile.zSpawn
    this.zSpeed = this.zSpawn / Transform3D.VISIBLE_BEATS
    this.zSpacingMul = Transform3D.Z_SPACING_MUL
    this.fovDeg = Transform3D.FOV_DEG
    this.cameraY = Transform3D.CAMERA_Y
    this.pitchRad = Transform3D.PITCH_DEG * DEG
    this.screenYInverted = true
    this.syncPitchTrig()
  }

  /**
   * Pick cameraZ so judge (Z=0) and spawn (Z=zSpawn) land in the golden bands,
   * then shrink lane width if the near plane overflows horizontally.
   */
  calibrateForViewport(): void {
    this.applyProjectionProfile(this.buildProjectionProfile())
    this.cameraZ = this.solveCameraZ()
    this.syncPitchTrig()

    const lane = this.project(this.trackHalfWidth, 0, Transform3D.Z_JUDGE, Transform3D.IDENTITY_DYNAMICS)
    if (lane) {
      const margin = this.canvasWidth * (this.isPortrait ? 0.44 : 0.46)
      const cx = this.canvasWidth * 0.5
      const half = Math.abs(lane.x - cx)
      if (half > margin) this.trackHalfWidth *= margin / half
    }
  }

  /** Search cameraZ that anchors judge + spawn on-screen for the current aspect. */
  private solveCameraZ(): number {
    const judgeTargetY = this.canvasHeight * (this.isPortrait ? 0.78 : 0.72)
    const spawnTargetY = this.canvasHeight * (this.isPortrait ? 0.28 : 0.32)

    let bestZ = Transform3D.CAMERA_Z
    let bestScore = Infinity

    for (let cz = -260; cz <= -18; cz += 2) {
      const judgeY = this.projectGroundY(0, cz)
      const spawnY = this.projectGroundY(this.zSpawn, cz)
      if (judgeY == null || spawnY == null) continue
      if (judgeY < 0 || judgeY > this.canvasHeight) continue
      if (spawnY < 0 || spawnY > this.canvasHeight) continue
      if (judgeY <= spawnY + 60) continue

      const score = Math.abs(judgeY - judgeTargetY) + Math.abs(spawnY - spawnTargetY)
      if (score < bestScore) {
        bestScore = score
        bestZ = cz
      }
    }

    return bestZ
  }

  /** Project ground (Y=0) at a world Z — used only for camera calibration. */
  private projectGroundY(worldZ: number, cameraZ: number): number | null {
    const focalLength = this.focalLength
    const cy = this.canvasHeight * this.vanishingPointYRatio
    const y = -this.cameraY
    const z = worldZ - cameraZ
    const rotY = y * this.cosP - z * this.sinP
    const rotZ = y * this.sinP + z * this.cosP
    if (rotZ <= 1) return null
    const term = (rotY * focalLength) / rotZ
    return this.screenYInverted ? cy - term : cy + term
  }

  setCanvasSize(width: number, height: number): void {
    this.canvasWidth = width
    this.canvasHeight = height
    this.calibrateForViewport()
  }

  private syncPitchTrig(): void {
    this.cosP = Math.cos(this.pitchRad)
    this.sinP = Math.sin(this.pitchRad)
  }

  beatAheadToZ(beatAhead: number): number {
    const z = beatAhead * this.zSpeed * this.zSpacingMul
    return Math.max(Transform3D.Z_JUDGE, Math.min(this.zSpawn, z))
  }

  /** Inverse of {@link beatAheadToZ} for Z-forward ribbon sampling. */
  zToBeatAhead(worldZ: number): number {
    const denom = this.zSpeed * this.zSpacingMul
    if (denom <= 0) return 0
    return worldZ / denom
  }

  /** Furthest beat-ahead visible before Z caps at zSpawn. */
  maxVisibleBeatAhead(): number {
    return this.zSpawn / Math.max(1, this.zSpeed * this.zSpacingMul)
  }

  /** Sky-chart Y → world height; peaks push toward camera for beam-skim arcs. */
  skyChartYToWorldY(chartY: number): number {
    const base = chartY * this.skyHeight
    if (chartY <= 0.05) return Math.max(0, base)
    const peakT = Math.min(1, chartY / 1.25)
    const ceiling = this.cameraY * 0.96
    return base * (1 - peakT * 0.4) + ceiling * peakT
  }

  worldXToLx(worldX: number): number {
    return worldX / this.trackHalfWidth
  }

  screenXToLx(screenX: number, dyn: CameraDynamics = Transform3D.IDENTITY_DYNAMICS): number {
    const p = this.projectGroundLane(1, 0, dyn)
    if (!p) return 0
    const cx = this.canvasWidth * 0.5
    const half = Math.abs(p.x - cx) || 1
    return Math.max(-1.05, Math.min(1.05, (screenX - cx) / half))
  }

  project(
    worldX: number,
    worldY: number,
    worldZ: number,
    dyn: CameraDynamics = Transform3D.IDENTITY_DYNAMICS,
  ): ProjectedPoint | null {
    const focalLength = this.focalLength
    const cx = this.canvasWidth * 0.5
    const cy = this.canvasHeight * this.vanishingPointYRatio

    const x = worldX
    const y = worldY - this.cameraY
    const z = worldZ - this.cameraZ

    const rotY = y * this.cosP - z * this.sinP
    const rotZ = y * this.sinP + z * this.cosP

    if (rotZ <= 1) return null

    const depthTerm = (rotY * focalLength) / rotZ
    let screenX = cx + (x * focalLength) / rotZ
    let screenY = this.screenYInverted ? cy - depthTerm : cy + depthTerm
    const scale = focalLength / rotZ

    if (dyn.bank !== 0) {
      const dx = screenX - cx
      const dy = screenY - cy
      const cb = Math.cos(dyn.bank)
      const sb = Math.sin(dyn.bank)
      screenX = cx + dx * cb - dy * sb * 0.15
      screenY = cy + dx * sb * 0.15 + dy * cb
    }

    screenX += dyn.offsetX
    screenY += dyn.offsetY

    const fog = Math.pow(Math.min(1, worldZ / this.zSpawn), 1.25)

    return { x: screenX, y: screenY, scale, rotZ, worldZ, fog }
  }

  projectVec(v: Vector3, dyn?: CameraDynamics): ProjectedPoint | null {
    return this.project(v.x, v.y, v.z, dyn)
  }

  projectGroundLane(lx: number, beatAhead: number, dyn?: CameraDynamics): ProjectedPoint | null {
    return this.project(lx * this.trackHalfWidth, 0, this.beatAheadToZ(beatAhead), dyn)
  }

  projectSkyPoint(sx: number, sy: number, beatAhead: number, dyn?: CameraDynamics): ProjectedPoint | null {
    return this.project(
      sx * this.trackHalfWidth,
      this.skyChartYToWorldY(sy),
      this.beatAheadToZ(beatAhead),
      dyn,
    )
  }

  spawnScreen(dyn?: CameraDynamics): ProjectedPoint | null {
    return this.project(0, 0, this.zSpawn, dyn)
  }

  static readonly IDENTITY_DYNAMICS: CameraDynamics = {
    bank: 0,
    offsetX: 0,
    offsetY: 0,
    shake: 0,
  }
}

export class ChaseCamera3D {
  private smoothBank = 0
  private shake = 0

  reset(): void {
    this.smoothBank = 0
    this.shake = 0
  }

  update(
    dt: number,
    tangent: Vector3,
    beatIntensity: number,
    restPhase: boolean,
  ): CameraDynamics {
    const bankTarget = Math.max(-0.12, Math.min(0.12, -tangent.x * 0.35))
    const lerp = 1 - Math.pow(0.001, dt)
    this.smoothBank += (bankTarget - this.smoothBank) * lerp * 0.55
    this.shake += ((restPhase ? 0.05 : 0.2 + beatIntensity * 0.35) - this.shake) * lerp * 0.4
    const shakeAmt = this.shake * 3.5
    return {
      bank: this.smoothBank,
      offsetX: (Math.random() - 0.5) * shakeAmt,
      offsetY: (Math.random() - 0.5) * shakeAmt * 0.45,
      shake: this.shake,
    }
  }
}

export const PENGUIN_MESH_SCALE = 0.19

export function penguinScreenPose(
  projected: ProjectedPoint,
  bank: number,
  tapPulse: number,
): { x: number; y: number; bank: number; scale: number } {
  return {
    x: projected.x,
    y: projected.y - 8 * projected.scale,
    bank,
    scale: projected.scale * PENGUIN_MESH_SCALE * (1 + tapPulse * 0.06),
  }
}
