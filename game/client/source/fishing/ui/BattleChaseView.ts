import { Container } from 'pixi.js'
import type { BeatClock } from '../systems/BeatClock'
import { PixiRenderBridge } from '../chase/PixiRenderBridge'
import { TrackSplineProvider, DEFAULT_SKY_CHART } from '../chase/TrackSplineProvider'
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
    this.track = new TrackSplineProvider(DEFAULT_SKY_CHART, this.transform)
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
}
