import { Container } from 'pixi.js'
import type { BeatClock } from '../systems/BeatClock'
import { PixiRenderBridge } from '../chase/PixiRenderBridge'
import { TrackSplineProvider } from '../chase/TrackSplineProvider'
import { DEMO_TRACK, LANE_X, type DemoTrack } from '../chase/DualLayerChart'
import { Transform3D } from '../chase/Transform3D'

export interface ChasePlayerPose {
  x: number
  y: number
  bank: number
  scale: number
}

/**
 * Facade: {@link Transform3D} projection + {@link TrackSplineProvider} + {@link PixiRenderBridge}.
 */
export class BattleChaseView {
  readonly container: Container
  readonly actorLayer: Container

  private readonly transform: Transform3D
  private readonly track: TrackSplineProvider
  private readonly bridge: PixiRenderBridge
  private active = false

  constructor() {
    this.transform = Transform3D.createForViewport(844, 390)
    this.track = new TrackSplineProvider(DEMO_TRACK.sky, this.transform, DEMO_TRACK.ground)
    this.bridge = new PixiRenderBridge(this.track, this.transform)
    this.container = this.bridge.container
    this.actorLayer = this.bridge.actorLayer
  }

  setLayout(width: number, height: number): void {
    this.bridge.setLayout(width, height)
  }

  setActive(on: boolean): void {
    this.active = on
    this.bridge.setActive(on)
  }

  isActive(): boolean {
    return this.active
  }

  setFishTint(color: number): void {
    this.bridge.setFishTint(color)
  }

  aimAtScreenX(screenX: number): void {
    this.bridge.aimAtScreenX(screenX)
  }

  aimAtRequiredLx(scrollBeats: number, screenCx: number, lateralHalfPx: number): void {
    const lx = this.track.getRequiredLxAtTime(scrollBeats)
    this.bridge.aimAtScreenX(screenCx + lx * lateralHalfPx)
  }

  requiredLxAtScroll(scrollBeats: number): number {
    return this.track.getRequiredLxAtTime(scrollBeats)
  }

  update(dtSeconds: number, nowMs: number, clock: BeatClock): void {
    if (!this.active || !clock.started) return
    const scroll = clock.currentBeat(nowMs) + clock.phase(nowMs)
    this.bridge.update(dtSeconds, nowMs, scroll)
  }

  getPlayerPose(): ChasePlayerPose {
    return this.bridge.getPenguinScreenPose()
  }

  triggerApexBurst(): void {
    this.bridge.triggerVisualEffect('apex', 'VortexBurst')
  }

  setComboCount(count: number): void {
    this.bridge.setComboCount(count)
  }

  /** Expose the track spline for ArcaeaJudge (floor notes + sky arcs). */
  getTrackProvider(): TrackSplineProvider {
    return this.track
  }

  /** Install a freshly generated per-battle chart (zone × record difficulty). */
  setChart(track: DemoTrack): void {
    this.track.setCharts(track.sky, track.ground)
  }

  /**
   * Deeper zones drive a more aggressive Z-forward push (water pressure). Maps
   * the design's `gameSpeed = 260 + zone*60` onto the beat→Z spacing multiplier.
   */
  setChaseSpeedForZone(zone: number): void {
    const gameSpeed = 260 + zone * 60
    this.transform.zSpacingMul = Transform3D.Z_SPACING_MUL * (gameSpeed / 300)
  }

  /** Expose the 3D transform for coordinate queries. */
  getTransform(): Transform3D {
    return this.transform
  }

  /** Penguin's current world-space lateral position (= playerLx * trackHalfWidth). */
  getPenguinWorldX(): number {
    return this.bridge.getPenguinWorldX()
  }

  /** Penguin's current world-space Y (height). */
  getPenguinWorldY(): number {
    return this.bridge.getPenguinWorldY()
  }

  /** Set visual state for a ground note at the given beat. */
  setGroundNoteState(beat: number, state: 'active' | 'pure' | 'far' | 'lost'): void {
    this.bridge.setGroundNoteState(beat, state)
  }

  /** Set visual glow state for the sky arc at the current scroll. */
  setSkyArcGlow(glowing: boolean): void {
    this.bridge.setSkyArcGlow(glowing)
  }

  /** Report the riding finger pixel position for the tether line (null = released). */
  setSkyTrackPointer(x: number | null, y: number | null): void {
    this.bridge.setSkyTrackPointer(x, y)
  }

  /** Steer the penguin toward a lane position (lx in -1..1). */
  aimAtLx(lx: number): void {
    const screenX = this.transform.projectGroundLane(lx, 0)
    if (screenX) this.bridge.aimAtScreenX(screenX.x)
  }

  /** Project a world point to screen pixels (this frame's camera dynamics). */
  projectWorldToScreen(worldX: number, worldY: number, worldZ: number): { x: number; y: number } | null {
    return this.bridge.projectWorldToScreen(worldX, worldY, worldZ)
  }

  /** Force the diver onto an arc's lateral position. */
  snapPenguinToLx(lx: number): void {
    this.bridge.snapPenguinToLx(lx)
  }

  /** Cavitation-bubble burst on a successful sky-arc tick. */
  emitArcTrackBurst(): void {
    this.bridge.emitArcTrackBurst()
  }

  /** Fire the seabed impact FX (line flash + ripple + sparks) on a floor hit. */
  triggerGroundHit(lane: number, judgement: 'PURE' | 'FAR' | 'LOST'): void {
    const lx = LANE_X[Math.max(0, Math.min(3, lane))] ?? 0
    const scr = this.bridge.projectWorldToScreen(lx * this.transform.trackHalfWidth, 0, 0)
    if (!scr) return
    this.bridge.spawnGroundImpact(scr.x, scr.y, judgement)
  }
}
