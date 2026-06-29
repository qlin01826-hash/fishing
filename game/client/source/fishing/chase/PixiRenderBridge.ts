import { Container, Graphics } from 'pixi.js'
import type { IRenderBridge, VisualEffectType } from './ITrackSplineProvider'
import type { TrackSplineProvider } from './TrackSplineProvider'
import { LANE_X } from './DualLayerChart'
import { BoidsFishSwarm } from './BoidsFishSwarm'
import {
  Transform3D,
  ChaseCamera3D,
  type CameraDynamics,
  type ProjectedPoint,
} from './Transform3D'
import { orientationFromTangent } from './ChaseKinematics'
import { Vector3, type Euler3 } from './math/Vector3'
import {
  RIBBON_STEP_Z,
  buildCrossSections,
  crossSectionsToQuads,
  drawRibbonQuad,
  waveOffsetX,
} from './ZForwardRibbon'
import { PenguinChaseRenderer } from './PenguinChaseRenderer'
import { DeepSeaAtmosphere } from './DeepSeaAtmosphere'
import { CanyonReefField } from './CanyonReefField'
import { TargetPreyFish } from './TargetPreyFish'
import { ChaseHudOverlay } from './ChaseHudOverlay'

/** Painter's-algorithm draw item — far (large worldZ) drawn first. */
interface RenderQueueItem {
  worldZ: number
  draw: (g: Graphics) => void
}

interface EntityRecord {
  type: 'Penguin' | 'BeatNode' | 'FishSwarm'
  world: Vector3
  rot: Euler3
  scale: Vector3
  burstT: number
}

/**
 * Arcaea dual-layer × ABZÛ atmosphere — all drawables via {@link Transform3D}.
 */
export class PixiRenderBridge implements IRenderBridge {
  readonly container = new Container()
  readonly actorLayer = new Container()

  private readonly atmosphere = new DeepSeaAtmosphere()
  private readonly canyon = new Graphics()
  private readonly reefField = new CanyonReefField()
  private readonly targetPrey = new TargetPreyFish()
  private readonly chaseHud = new ChaseHudOverlay()
  private readonly ground = new Graphics()
  private readonly beatGrid = new Graphics()
  private readonly skyGuides = new Graphics()
  private readonly fish = new Graphics()
  /** Unified Z-sorted layer for beat nodes, arc ribbons, particles, bursts. */
  private readonly depthSorted = new Graphics()
  private readonly judge = new Graphics()
  private readonly speedLines = new Graphics()

  private readonly trackProvider: TrackSplineProvider
  private readonly transform: Transform3D
  private readonly camera = new ChaseCamera3D()
  private readonly swarm = new BoidsFishSwarm()
  private readonly penguinChase = new PenguinChaseRenderer()
  private readonly entities = new Map<string, EntityRecord>()

  private active = false
  private fishTint = 0xff8844
  private scrollBeats = 0
  private playerLx = 0
  private targetLx = 0
  private tapPulse = 0
  private ribbonTime = 0
  private pengWorldY = 0
  private prevScrollBeats = 0
  private lastDyn: CameraDynamics = Transform3D.IDENTITY_DYNAMICS
  private lastPengPose = { x: 0, y: 0, bank: 0, scale: 0.5 }

  constructor(trackProvider: TrackSplineProvider, transform: Transform3D) {
    this.trackProvider = trackProvider
    this.transform = transform
    this.container.addChild(
      this.atmosphere.container,
      this.canyon,
      this.targetPrey.container,
      this.ground,
      this.beatGrid,
      this.skyGuides,
      this.fish,
      this.depthSorted,
      this.penguinChase.container,
      this.actorLayer,
      this.judge,
      this.speedLines,
      this.chaseHud.container,
    )
    this.container.visible = false
    this.createRenderEntity('Penguin', 'penguin')
  }

  setLayout(width: number, height: number): void {
    this.transform.setCanvasSize(width, height)
    this.trackProvider.setTransform(this.transform)
    this.atmosphere.resize(width, height, this.transform)
    this.chaseHud.setLayout(width, height)
  }

  setActive(on: boolean): void {
    if (on === this.active) {
      this.container.visible = on
      return
    }
    this.active = on
    this.container.visible = on
    if (on) {
      this.camera.reset()
      this.swarm.clear()
      this.scrollBeats = 0
      this.playerLx = 0
      this.targetLx = 0
      this.tapPulse = 0
      this.ribbonTime = 0
      this.pengWorldY = 0
      this.prevScrollBeats = 0
      this.atmosphere.reset()
      this.reefField.reset()
    } else {
      this.swarm.clear()
      this.penguinChase.clear()
    }
  }

  setFishTint(color: number): void {
    this.fishTint = color
  }

  createRenderEntity(type: 'Penguin' | 'BeatNode' | 'FishSwarm', id: string): void {
    this.entities.set(id, {
      type,
      world: new Vector3(),
      rot: { pitch: 0, yaw: 0, roll: 0 },
      scale: new Vector3(1, 1, 1),
      burstT: 0,
    })
  }

  updateEntityTransform(id: string, position: Vector3, rotation: Euler3, scale: Vector3): void {
    const e = this.entities.get(id)
    if (!e) return
    e.world.copy(position)
    e.rot = { ...rotation }
    e.scale.copy(scale)
  }

  triggerVisualEffect(id: string, effectType: VisualEffectType): void {
    const e = this.entities.get(id)
    if (e) e.burstT = 1
    if (effectType === 'WaterSplash') this.tapPulse = 1
  }

  setEnvironmentFlowState(state: 'Gaps_Escort' | 'Beat_Evacuation', intensity: number): void {
    this.swarm.setFlowState(state, intensity)
  }

  aimAtScreenX(screenX: number): void {
    if (!this.active) return
    this.targetLx = this.transform.screenXToLx(screenX, this.lastDyn)
    this.tapPulse = 1
  }

  setComboCount(count: number): void {
    this.chaseHud.setComboCount(count)
  }

  update(_dtSeconds: number, _nowMs: number, scrollBeats: number): void {
    if (!this.active) return
    const beatDelta = Math.max(0, scrollBeats - this.prevScrollBeats)
    this.prevScrollBeats = scrollBeats
    const beatDz = beatDelta * this.transform.zSpeed * this.transform.zSpacingMul
    const worldDz = beatDz > 0.001 ? beatDz : _dtSeconds * this.transform.zSpeed * 3.8
    this.scrollBeats = scrollBeats
    this.playerLx += (this.targetLx - this.playerLx) * Math.min(1, _dtSeconds * 14)
    this.tapPulse = Math.max(0, this.tapPulse - _dtSeconds * 5)
    this.ribbonTime += _dtSeconds
    this.atmosphere.update(_dtSeconds, this.ribbonTime, worldDz, this.transform)
    this.reefField.update(worldDz, this.transform)
    this.targetPrey.update(_dtSeconds)
    for (const e of this.entities.values()) e.burstT = Math.max(0, e.burstT - _dtSeconds * 3)
    this.redraw(_dtSeconds, _nowMs)
  }

  getPenguinScreenPose(): { x: number; y: number; bank: number; scale: number } {
    return this.lastPengPose
  }

  private redraw(dt: number, nowMs: number): void {
    const scroll = this.scrollBeats
    const tangent = this.trackProvider.getTangentAtTime(scroll)
    const rest = this.isRestWindow(scroll)
    const evac = !rest || this.hasUpcomingAction(scroll, 1.5)
    this.swarm.setFlowState(evac ? 'Beat_Evacuation' : 'Gaps_Escort', rest ? 1 : 0.35)

    const dyn = this.camera.update(dt, tangent, this.tapPulse, rest)
    this.lastDyn = dyn

    const pengZ = Transform3D.PENGUIN_CHASE_Z
    const wave = waveOffsetX(pengZ, this.ribbonTime, this.transform.trackHalfWidth)
    const worldX = this.playerLx * this.transform.trackHalfWidth + wave
    const sky = this.trackProvider.skyAtBeat(scroll)
    const targetY = this.transform.skyChartYToWorldY(sky.y)
    const yLerp = 1 - Math.pow(0.001, Math.max(0.001, dt) * 22)
    this.pengWorldY += (targetY - this.pengWorldY) * yLerp

    const pengWorld = new Vector3(worldX, this.pengWorldY, pengZ)
    const orient = orientationFromTangent(tangent)
    const roll =
      orient.roll + dyn.bank + (this.targetLx - this.playerLx) * 0.28
    const pitch = orient.pitch
    const bankIntensity = Math.min(1, Math.abs(roll) / (25 * Math.PI / 180))

    this.updateEntityTransform('penguin', pengWorld, orient, new Vector3(1, 1, 1))
    this.penguinChase.draw(
      dt,
      this.transform,
      dyn,
      pengWorld,
      roll,
      pitch,
      bankIntensity,
      this.tapPulse,
      nowMs,
    )
    const bodyProj = this.penguinChase.lastBodyScreen
    this.lastPengPose = bodyProj
      ? {
          x: bodyProj.x,
          y: bodyProj.y - 8 * bodyProj.scale,
          bank: roll,
          scale: bodyProj.scale * 0.19,
        }
      : {
          x: this.transform.canvasWidth * 0.5,
          y: this.transform.canvasHeight * 0.62,
          bank: roll,
          scale: 0.45,
        }

    this.drawAbzuBg(dyn, nowMs)
    this.drawCanyonWalls(dyn)
    this.targetPrey.draw(this.transform, dyn, nowMs, this.fishTint)
    this.drawZForwardGroundRibbon(scroll, dyn)
    this.penguinChase.drawShadow(this.ground, this.transform, dyn, pengWorld)
    this.drawZForwardBeatGrid(scroll, dyn)
    this.drawZForwardLaneLines(scroll, dyn)
    this.drawSkyGuides(scroll, dyn)
    this.swarm.update(dt, scroll, this.trackProvider, this.transform, dyn)
    this.fish.clear()
    this.swarm.draw(this.fish, this.transform, dyn, this.fishTint)

    const renderQueue: RenderQueueItem[] = []
    this.collectZForwardSkyRibbon(scroll, dyn, renderQueue)
    this.collectGroundNotes(scroll, dyn, renderQueue)
    this.collectSkyNodes(scroll, dyn, renderQueue)
    this.collectArcParticles(scroll, dyn, renderQueue)
    this.collectEntityBursts(dyn, renderQueue)
    this.flushDepthSorted(renderQueue)

    this.drawJudgeLines(dyn)
    this.drawSpeedLines(dyn)
  }

  /** Painter's algorithm: far (large Z) first, near (small Z) last. */
  private flushDepthSorted(queue: RenderQueueItem[]): void {
    const g = this.depthSorted
    g.clear()
    queue.sort((a, b) => b.worldZ - a.worldZ)
    for (const item of queue) item.draw(g)
  }

  private pg(lx: number, beatAhead: number, dyn: CameraDynamics): ProjectedPoint | null {
    return this.transform.projectGroundLane(lx, beatAhead, dyn)
  }

  private ps(sx: number, sy: number, beatAhead: number, dyn: CameraDynamics): ProjectedPoint | null {
    return this.transform.projectSkyPoint(sx, sy, beatAhead, dyn)
  }

  private isRestWindow(scroll: number): boolean {
    let n = 0
    for (let b = Math.floor(scroll); b < Math.floor(scroll) + 5; b++) {
      if (this.trackProvider.isRestPhaseAtBeat(b)) n++
      else break
    }
    return n >= 1
  }

  private hasUpcomingAction(scroll: number, within: number): boolean {
    for (let b = Math.ceil(scroll); b <= Math.ceil(scroll) + within; b++) {
      const g = this.trackProvider.getGroundNodeAtBeat(b)
      const s = this.trackProvider.getSkyNodeAtBeat(b)
      if (g.type !== 'rest' || s.type !== 'rest') return true
    }
    return false
  }

  private drawAbzuBg(dyn: CameraDynamics, nowMs: number): void {
    const spawn = this.transform.spawnScreen(dyn)
    const vanishY = spawn?.y ?? this.transform.canvasHeight * 0.12
    this.atmosphere.draw(vanishY, nowMs, this.transform, dyn)
  }

  private drawCanyonWalls(dyn: CameraDynamics): void {
    const g = this.canyon
    const { canvasWidth: w, canvasHeight: h } = this.transform
    const spawn = this.transform.spawnScreen(dyn)
    const vanishY = spawn?.y ?? h * 0.1
    g.clear()
    const cx = w * 0.5
    const wallZ = [this.transform.zSpawn, this.transform.zSpawn * 0.33, Transform3D.Z_JUDGE]
    for (const side of [-1, 1]) {
      const pts = wallZ
        .map((z) => this.transform.project(side * this.transform.trackHalfWidth * 1.35, 0, z, dyn))
        .filter((p): p is ProjectedPoint => p !== null)
      if (pts.length < 2) continue
      g.moveTo(side < 0 ? 0 : w, 0)
      for (const p of pts) g.lineTo(p.x, p.y)
      g.lineTo(side < 0 ? 0 : w, h)
      g.closePath()
      g.fill({ color: side < 0 ? 0x061820 : 0x051418, alpha: 0.55 })
    }
    this.reefField.draw(g, this.transform, dyn)
    void vanishY
    void cx
  }

  private maxBeatAhead(): number {
    return this.transform.maxVisibleBeatAhead()
  }

  /** Ground highway — Z slices from judge (z=0) to zSpawn, constant world half-width. */
  private drawZForwardGroundRibbon(scroll: number, dyn: CameraDynamics): void {
    const g = this.ground
    g.clear()
    const sections = buildCrossSections(this.transform, this.trackProvider, scroll, this.ribbonTime, 'ground')
    const quads = crossSectionsToQuads(sections, this.transform, dyn, false)
    for (let i = quads.length - 1; i >= 0; i--) {
      const q = quads[i]
      drawRibbonQuad(g, q, 0xd8ece4, 0.34, 0xa8c8b8, 0.32, q.bl.scale)
    }
  }

  /** Horizontal beat ticks — one slice per stepZ along depth. */
  private drawZForwardBeatGrid(scroll: number, dyn: CameraDynamics): void {
    const g = this.beatGrid
    g.clear()
    const zMax = this.transform.zSpawn
    let prevY = -1

    for (let worldZ = 0; worldZ <= zMax; worldZ += RIBBON_STEP_Z) {
      const beatAhead = this.transform.zToBeatAhead(worldZ)
      const beat = scroll + beatAhead
      const sky = this.trackProvider.skyAtBeat(beat)
      const wave = Math.sin(worldZ * 0.005 - this.ribbonTime * 2.4) * this.transform.trackHalfWidth * 0.04
      const cx = sky.x * this.transform.trackHalfWidth + wave
      const hw = this.transform.trackHalfWidth * 1.02

      const L = this.transform.project(cx - hw, 0, worldZ, dyn)
      const R = this.transform.project(cx + hw, 0, worldZ, dyn)
      if (!L || !R) continue

      const dy = prevY < 0 ? 99 : Math.abs(prevY - L.y)
      prevY = L.y
      const major = Math.abs(beat - Math.round(beat)) < 0.08
      const alpha = Math.min(0.48, 0.05 + 0.2 / (dy * 0.04 + 1)) * (1 - L.fog * 0.6)
      g.moveTo(L.x, L.y)
      g.lineTo(R.x, R.y)
      g.stroke({ color: 0x8898a0, width: major ? 1.1 : 0.55, alpha })
    }
  }

  /** Lane rails — each lane lx swept from z=0 → zSpawn. */
  private drawZForwardLaneLines(scroll: number, dyn: CameraDynamics): void {
    const g = this.beatGrid
    const zMax = this.transform.zSpawn

    for (const lane of LANE_X) {
      let prev: ProjectedPoint | null = null
      for (let worldZ = 0; worldZ <= zMax; worldZ += RIBBON_STEP_Z) {
        const beatAhead = this.transform.zToBeatAhead(worldZ)
        const sky = this.trackProvider.skyAtBeat(scroll + beatAhead)
        const wave = Math.sin(worldZ * 0.005 - this.ribbonTime * 2.4) * this.transform.trackHalfWidth * 0.04
        const cx = sky.x * this.transform.trackHalfWidth + wave
        const wx = cx + lane * this.transform.trackHalfWidth * 0.92
        const p = this.transform.project(wx, 0, worldZ, dyn)
        if (!p) continue
        if (prev) {
          g.moveTo(prev.x, prev.y)
          g.lineTo(p.x, p.y)
          g.stroke({ color: 0x607880, width: 1, alpha: 0.34 * (1 - p.fog * 0.5) })
        }
        prev = p
      }
    }
  }

  /** Sky melody ribbon — Z-forward mesh enqueued for depth sort. */
  private collectZForwardSkyRibbon(
    scroll: number,
    dyn: CameraDynamics,
    queue: RenderQueueItem[],
  ): void {
    const sections = buildCrossSections(this.transform, this.trackProvider, scroll, this.ribbonTime, 'sky')
    const quads = crossSectionsToQuads(sections, this.transform, dyn, true)

    for (const q of quads) {
      const hold = q.isHold
      const fillColor = hold ? 0x40c8e0 : 0x68e0f8
      const strokeColor = hold ? 0xffffff : 0xb8f4ff
      const fillAlpha = hold ? 0.42 : 0.24
      const strokeAlpha = hold ? 0.82 : 0.55
      const worldZ = q.worldZ

      queue.push({
        worldZ,
        draw: (g) => {
          drawRibbonQuad(g, q, fillColor, fillAlpha, strokeColor, strokeAlpha, q.tl.scale)
          g.moveTo(q.tl.x, q.tl.y)
          g.lineTo(q.tr.x, q.tr.y)
          g.stroke({ color: fillColor, width: 7 * q.tl.scale, alpha: fillAlpha * 0.35, cap: 'round' })
        },
      })
    }
  }

  private drawSkyGuides(scroll: number, dyn: CameraDynamics): void {
    const g = this.skyGuides
    g.clear()
    const next = Math.ceil(scroll)
    for (let b = next; b < next + 6; b++) {
      const beatAhead = b - scroll
      if (beatAhead < 0.3 || beatAhead > Math.min(10, this.maxBeatAhead())) continue
      const s = this.trackProvider.skyAtBeat(b)
      const sky = this.ps(s.x, s.y, beatAhead, dyn)
      const floor = this.pg(s.x, beatAhead, dyn)
      if (!sky || !floor || sky.y >= floor.y - 4) continue
      g.moveTo(sky.x, sky.y)
      g.lineTo(floor.x, floor.y)
      g.stroke({ color: 0x68d8f0, width: 1, alpha: 0.22 * sky.scale })
    }
  }

  private collectGroundNotes(scroll: number, dyn: CameraDynamics, queue: RenderQueueItem[]): void {
    for (let b = Math.ceil(scroll) - 1; b < scroll + 14; b++) {
      const beatAhead = b - scroll
      if (beatAhead < -0.1 || beatAhead > this.maxBeatAhead()) continue
      const node = this.trackProvider.getGroundNodeAtBeat(b)
      if (node.type === 'rest') continue
      const lx = LANE_X[Math.max(0, Math.min(3, node.lane))]
      const p = this.pg(lx, beatAhead, dyn)
      if (!p) continue
      const worldZ = this.transform.beatAheadToZ(beatAhead)
      const hit = beatAhead < 0.08
      const w = (10 + p.scale * 12) * (node.type === 'hold' ? 1.5 : 1)
      const h = (5 + p.scale * 7) * (node.type === 'hold' ? 1 : 1)
      queue.push({
        worldZ,
        draw: (g) => {
          g.roundRect(p.x - w * 0.5, p.y - h, w, h, 2)
          g.fill({ color: hit ? 0xb8ecff : 0x68b8e8, alpha: hit ? 0.85 : 0.55 })
          g.stroke({ color: 0xffffff, width: 1, alpha: 0.4 })
        },
      })
    }
  }

  private collectSkyNodes(scroll: number, dyn: CameraDynamics, queue: RenderQueueItem[]): void {
    for (let b = Math.ceil(scroll) - 1; b < scroll + 14; b++) {
      const beatAhead = b - scroll
      if (beatAhead < -0.1 || beatAhead > this.maxBeatAhead()) continue
      const node = this.trackProvider.getSkyNodeAtBeat(b)
      if (node.type !== 'tap') continue
      const s = this.trackProvider.skyAtBeat(b)
      const p = this.ps(s.x, s.y, beatAhead, dyn)
      if (!p) continue
      const worldZ = this.transform.beatAheadToZ(beatAhead)
      const hit = beatAhead < 0.08
      const sz = (4 + p.scale * 7) * (hit ? 1.15 : 1)
      queue.push({
        worldZ,
        draw: (g) => {
          g.moveTo(p.x, p.y - sz)
          g.lineTo(p.x + sz, p.y)
          g.lineTo(p.x, p.y + sz)
          g.lineTo(p.x - sz, p.y)
          g.closePath()
          g.fill({ color: hit ? 0xf0fcff : 0xffffff, alpha: 0.9 })
          g.stroke({ color: 0x9a7aff, width: 1.2, alpha: hit ? 0.9 : 0.5 })
        },
      })
    }
  }

  private collectArcParticles(scroll: number, dyn: CameraDynamics, queue: RenderQueueItem[]): void {
    for (let ba = 0.5; ba < Math.min(12, this.maxBeatAhead()); ba += 0.6) {
      const s = this.trackProvider.skyAtBeat(scroll + ba)
      const p = this.ps(s.x, s.y, ba, dyn)
      if (!p) continue
      const worldZ = this.transform.beatAheadToZ(ba)
      queue.push({
        worldZ,
        draw: (g) => {
          g.ellipse(p.x, p.y, p.scale * 4, p.scale * 1.5)
          g.fill({ color: 0xb0ecff, alpha: 0.05 + p.scale * 0.1 })
        },
      })
    }
  }

  private collectEntityBursts(dyn: CameraDynamics, queue: RenderQueueItem[]): void {
    for (const e of this.entities.values()) {
      if (e.burstT <= 0) continue
      const p = this.transform.projectVec(e.world, dyn)
      if (!p) continue
      const worldZ = e.world.z
      const burstT = e.burstT
      queue.push({
        worldZ,
        draw: (g) => {
          g.circle(p.x, p.y, 14 * burstT * p.scale * 0.15)
          g.stroke({ color: 0xffffff, width: 2, alpha: burstT * 0.55 })
        },
      })
    }
  }

  private drawJudgeLines(dyn: CameraDynamics): void {
    const g = this.judge
    g.clear()
    const nL = this.pg(-1.05, 0, dyn)
    const nR = this.pg(1.05, 0, dyn)
    const skyL = this.ps(-1.05, 0.5, 0, dyn)
    const skyR = this.ps(1.05, 0.5, 0, dyn)

    if (skyL && skyR) {
      g.moveTo(skyL.x, skyL.y)
      g.lineTo(skyR.x, skyR.y)
      g.stroke({ color: 0xf0a8d8, width: 1.5, alpha: 0.35 })
    }

    if (nL && nR) {
      g.moveTo(nL.x, nL.y)
      g.lineTo(nR.x, nR.y)
      g.stroke({ color: 0x9858b8, width: 3, alpha: 0.88 })
      const req = this.trackProvider.getRequiredLxAtTime(this.scrollBeats)
      const aim = this.pg(req, 0, dyn)
      if (aim) {
        g.circle(aim.x, nL.y, 5)
        g.stroke({ color: 0xc8a0e8, width: 1.2, alpha: 0.4 })
      }
    }
  }

  private drawSpeedLines(dyn: CameraDynamics): void {
    const g = this.speedLines
    g.clear()
    if (dyn.shake < 0.1) return
    const { canvasWidth: w, canvasHeight: h } = this.transform
    for (let i = 0; i < 12; i++) {
      const x = (i / 12) * w
      g.moveTo(x, h * 0.12)
      g.lineTo(x + 6, h * 0.12 + 25 + dyn.shake * 40)
      g.stroke({ color: 0xe0f4e8, width: 1, alpha: dyn.shake * 0.2 })
    }
  }

}
