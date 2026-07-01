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
  buildCrossSections,
  crossSectionsToQuads,
  drawRibbonQuad,
  waveOffsetX,
  zSliceStep,
} from './ZForwardRibbon'
import { PenguinChaseRenderer } from './PenguinChaseRenderer'
import { SkyJuiceFx } from './SkyJuiceFx'
import { DeepSeaAtmosphere } from './DeepSeaAtmosphere'
import { CanyonReefField } from './CanyonReefField'
import { TargetPreyFish } from './TargetPreyFish'
import { ChaseHudOverlay } from './ChaseHudOverlay'

/** Linear RGB lerp between two 0xRRGGBB colors (t in 0..1) — depth cueing. */
function lerpHex(a: number, b: number, t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const r = Math.round(ar + (((b >> 16) & 255) - ar) * u)
  const g = Math.round(ag + (((b >> 8) & 255) - ag) * u)
  const bl = Math.round(ab + ((b & 255) - ab) * u)
  return (r << 16) | (g << 8) | bl
}

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

interface GroundSpark {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  max: number
}

interface GroundImpact {
  x: number
  y: number
  color: number
  isPure: boolean
  ringLife: number
  ringMax: number
  flashLife: number
  flashMax: number
  sparks: GroundSpark[]
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
  /** Additive layer for seabed tap-impact FX (line flash, ripple, sparks). */
  private readonly groundFx = new Graphics()
  /** Additive ('lighter') layer: neon arc bloom, hit anchor, tether arcs. */
  private readonly fxGlow = new Graphics()
  private readonly speedLines = new Graphics()

  private readonly trackProvider: TrackSplineProvider
  private readonly transform: Transform3D
  private readonly camera = new ChaseCamera3D()
  private readonly swarm = new BoidsFishSwarm()
  private readonly penguinChase = new PenguinChaseRenderer()
  private readonly entities = new Map<string, EntityRecord>()
  private readonly skyJuice = new SkyJuiceFx()
  /** Continuous-track hold time + smoothed turbo factor for the wide-angle juice. */
  private trackHeldMs = 0
  private turboT = 0
  /** Live seabed tap-impact bursts (ring ripple + gravity sparks + line flash). */
  private readonly groundImpacts: GroundImpact[] = []

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
      this.groundFx,
      this.fxGlow,
      this.speedLines,
      this.chaseHud.container,
    )
    this.fxGlow.blendMode = 'add'
    this.groundFx.blendMode = 'add'
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
      this.skyTrackPointer = null
      this.skyArcGlowing = false
      this.skyJuice.reset()
      this.trackHeldMs = 0
      this.turboT = 0
      this.transform.focalScale = 1
      this.container.x = 0
      this.container.y = 0
    } else {
      this.swarm.clear()
      this.penguinChase.clear()
      this.skyTrackPointer = null
      this.skyJuice.reset()
      this.fxGlow.clear()
      this.trackHeldMs = 0
      this.turboT = 0
      this.transform.focalScale = 1
      this.container.x = 0
      this.container.y = 0
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

  getPenguinWorldX(): number {
    return this.playerLx * this.transform.trackHalfWidth
  }

  getPenguinWorldY(): number {
    return this.pengWorldY
  }

  /** Project a world point to screen pixels using THIS frame's camera dynamics. */
  projectWorldToScreen(worldX: number, worldY: number, worldZ: number): { x: number; y: number } | null {
    const p = this.transform.project(worldX, worldY, worldZ, this.lastDyn)
    return p ? { x: p.x, y: p.y } : null
  }

  /** Force the diver's lateral position onto an arc (lx in -1..1) — RIGID. */
  snapPenguinToLx(lx: number): void {
    // Zero-latency hard lock: easing here is exactly what makes the diver
    // visibly trail the finger by a frame. The slide x is already continuous,
    // so a direct set reads perfectly smooth while staying glued to the input.
    this.targetLx = lx
    this.playerLx = lx
  }

  /** Cavitation-bubble burst on a successful arc tick. */
  emitArcTrackBurst(): void {
    this.tapPulse = 1
    const peng = this.entities.get('penguin')
    if (peng) peng.burstT = 1
  }

  // ---- Arcaea visual state ----

  private groundNoteStates = new Map<number, 'active' | 'pure' | 'far' | 'lost'>()
  private skyArcGlowing = false
  /** Pixel position of the finger currently riding the sky stream (tether line). */
  private skyTrackPointer: { x: number; y: number } | null = null

  setGroundNoteState(beat: number, state: 'active' | 'pure' | 'far' | 'lost'): void {
    this.groundNoteStates.set(beat, state)
  }

  setSkyArcGlow(glowing: boolean): void {
    this.skyArcGlowing = glowing
  }

  setSkyTrackPointer(x: number | null, y: number | null): void {
    this.skyTrackPointer = x === null || y === null ? null : { x, y }
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
    // Turbo doubles the marine-snow recede speed for the "sucking in speed" feel.
    this.atmosphere.update(_dtSeconds, this.ribbonTime, worldDz * (1 + this.turboT), this.transform)
    this.reefField.update(worldDz, this.transform)
    this.targetPrey.update(_dtSeconds)
    for (const e of this.entities.values()) e.burstT = Math.max(0, e.burstT - _dtSeconds * 3)
    this.redraw(_dtSeconds, _nowMs)
  }

  getPenguinScreenPose(): { x: number; y: number; bank: number; scale: number } {
    return this.lastPengPose
  }

  private redraw(dt: number, nowMs: number): void {
    // Turbo Mode: after riding the stream continuously for >0.5s, smoothly widen
    // the lens (focalScale↓) for a time-tunnel stretch; snap back fast on release.
    // Set BEFORE any projection so the whole frame shares the wide-angle.
    if (this.skyArcGlowing) this.trackHeldMs += dt * 1000
    else this.trackHeldMs = 0
    const turboTarget = this.skyArcGlowing && this.trackHeldMs > 500 ? 1 : 0
    this.turboT += (turboTarget - this.turboT) * Math.min(1, dt * (turboTarget ? 3 : 16))
    this.transform.focalScale = 1 - this.turboT * 0.1

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
    // Rigid vertical lock while riding (no trailing); gentle ease otherwise.
    const yLerp = this.skyArcGlowing ? 1 : 1 - Math.pow(0.001, Math.max(0.001, dt) * 22)
    this.pengWorldY += (targetY - this.pengWorldY) * yLerp

    const pengWorld = new Vector3(worldX, this.pengWorldY, pengZ)
    const orient = orientationFromTangent(tangent)
    const roll =
      orient.roll + dyn.bank + (this.targetLx - this.playerLx) * 0.28
    const pitch = orient.pitch
    const bankIntensity = Math.min(1, Math.abs(roll) / (25 * Math.PI / 180))

    this.updateEntityTransform('penguin', pengWorld, orient, new Vector3(1, 1, 1))
    // Zero-latency weld: while a finger rides the lit slide, drive the diver's
    // on-screen pixel straight from the pointer (bypassing the 3D/audio step
    // gap) and back-sync the lateral world so the tether/particles stay coherent.
    const rigidWeld = this.skyArcGlowing && this.skyTrackPointer ? this.skyTrackPointer : null
    if (rigidWeld) {
      this.playerLx = this.transform.screenXToLx(rigidWeld.x, dyn)
    }
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
      rigidWeld,
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
    this.updateGroundImpacts(dt)
    this.drawSkyFx(dt, dyn)
    this.drawSpeedLines(dyn)

    // Camera-shake juice: tiny per-frame jitter of the whole chase view while
    // a finger is locked on the stream — reads as deep-current turbulence/speed.
    if (this.skyArcGlowing) {
      this.container.x = (Math.random() - 0.5) * 2
      this.container.y = (Math.random() - 0.5) * 2
    } else if (this.container.x !== 0 || this.container.y !== 0) {
      this.container.x = 0
      this.container.y = 0
    }
  }

  /** Painter's algorithm: far (large Z) first, near (small Z) last. */
  private flushDepthSorted(queue: RenderQueueItem[]): void {
    const g = this.depthSorted
    g.clear()
    queue.sort((a, b) => b.worldZ - a.worldZ)
    for (const item of queue) item.draw(g)
  }

  /**
   * Seabed tap-impact burst: a violent "break-the-water" hit at the pixel where
   * a floor pearl was struck. PURE also flashes the judge line white.
   */
  spawnGroundImpact(x: number, y: number, judgement: 'PURE' | 'FAR' | 'LOST'): void {
    if (judgement === 'LOST') return
    const color = judgement === 'PURE' ? 0xffff44 : 0x00ff66
    const sparks: GroundSpark[] = []
    for (let i = 0; i < 12; i++) {
      const side = i % 2 === 0 ? -1 : 1
      // Fan upward and out to both sides, then gravity drags them back down.
      const ang = -Math.PI / 2 + side * (0.25 + Math.random() * 0.95)
      const spd = 130 + Math.random() * 190
      sparks.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 0.4 + Math.random() * 0.25,
        max: 0.65,
      })
    }
    this.groundImpacts.push({
      x,
      y,
      color,
      isPure: judgement === 'PURE',
      ringLife: 0.2,
      ringMax: 0.2,
      flashLife: 0.1,
      flashMax: 0.1,
      sparks,
    })
  }

  private updateGroundImpacts(dt: number): void {
    const g = this.groundFx
    g.clear()
    for (let i = this.groundImpacts.length - 1; i >= 0; i--) {
      const im = this.groundImpacts[i]
      im.ringLife -= dt
      im.flashLife -= dt

      // (1) Expanding shock ring: 10px → 60px in 0.2s, fading to zero.
      if (im.ringLife > 0) {
        const t = 1 - im.ringLife / im.ringMax
        const r = 10 + t * 50
        g.circle(im.x, im.y, r)
        g.stroke({ color: im.color, width: 1 + 3 * (1 - t), alpha: (1 - t) * 0.9 })
      }

      // (2) Judge-line white flash across the struck lane (PURE only), 0.1s.
      if (im.isPure && im.flashLife > 0) {
        const fa = im.flashLife / im.flashMax
        g.moveTo(im.x - 72, im.y)
        g.lineTo(im.x + 72, im.y)
        g.stroke({ color: 0xffffff, width: 1 + 6 * fa, alpha: fa, cap: 'round' })
      }

      // (3) Gravity sparks arcing up and out.
      let anySpark = false
      for (const sp of im.sparks) {
        sp.life -= dt
        if (sp.life <= 0) continue
        anySpark = true
        sp.vy += 560 * dt
        sp.x += sp.vx * dt
        sp.y += sp.vy * dt
        const st = sp.life / sp.max
        g.circle(sp.x, sp.y, 0.6 + 2.2 * st)
        g.fill({ color: im.color, alpha: st })
      }

      if (im.ringLife <= 0 && im.flashLife <= 0 && !anySpark) {
        this.groundImpacts.splice(i, 1)
      }
    }
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

    for (let worldZ = 0; worldZ <= zMax; worldZ += zSliceStep(worldZ, zMax)) {
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
      // Lanes are faint guides — sample even coarser (1.7× step) than ribbons.
      for (let worldZ = 0; worldZ <= zMax; worldZ += zSliceStep(worldZ, zMax) * 1.7) {
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

    // High-voltage state switch: the WHOLE continuous stream changes material
    // when a finger is riding it (skyArcGlowing) — energised neon magenta vs
    // calm deep-sea blue when idle.
    const energised = this.skyArcGlowing
    // Depth-cueing ranges: alpha ramps across the near HALF; thickness bounce
    // only swells in the nearest ~16% (the "breaking-wave" head).
    const zNear = this.transform.zSpawn * 0.5
    const zHead = this.transform.zSpawn * 0.16
    for (const q of quads) {
      // Rhythmic breathing: a rest beat carves a clean gap in the ribbon so the
      // phrase splits into separate air-slides with room for the floor burst.
      if (q.isRest) continue

      const hold = q.isHold
      const worldZ = q.worldZ

      // Exponential "near solid / far ghost" depth cueing. proximity = 1 at the
      // judge plane, 0 by the mid-field; pow() makes the far end melt into the
      // deep-sea ink so only the imminent head reads as a bright solid.
      const proximity = Math.max(0, 1 - worldZ / zNear)
      const depthAlpha = Math.pow(proximity, 2.5)

      let fillColor: number
      let strokeColor: number
      let fillAlpha: number
      let strokeAlpha: number
      if (energised) {
        // Riding = HOLLOW neon-glass tube: soft PINK edges (never white — dozens
        // of stacked near-quad top-edges in white saturated into the "death-white
        // slab"), near-transparent interior (max ~0.15) so the player sees the
        // seabed pearls THROUGH the lit slide.
        fillColor = lerpHex(0xff2a9a, 0xff9ad8, proximity)
        strokeColor = 0xff8ad8
        fillAlpha = 0.15 * (0.4 + 0.6 * depthAlpha)
        strokeAlpha = 0.16 + 0.3 * depthAlpha
      } else {
        // Idle: far cold deep-blue (#1a3a4a) → near electric cyan (#00f0ff).
        fillColor = lerpHex(0x1a3a4a, hold ? 0x40e0ff : 0x00f0ff, proximity)
        strokeColor = lerpHex(0x244a5a, 0xb8f4ff, proximity)
        fillAlpha = 0.04 + (hold ? 0.78 : 0.66) * depthAlpha
        strokeAlpha = 0.06 + 0.72 * depthAlpha
      }

      // Occlusion avoidance: idle slices in front of a floor note nearly vanish
      // so the player's sight-line punches through to the rising seabed pearls.
      if (!energised && q.floorBehind) {
        fillAlpha = Math.min(fillAlpha, 0.08)
        strokeAlpha = Math.min(strokeAlpha, 0.14)
      }

      // Head bounce: width + glow swell as the slice nears the judge plane,
      // building a thick "breaking-wave" car-head that screams "press here now".
      const nearBoost = 1 + Math.max(0, 1 - worldZ / zHead) * 1.5

      queue.push({
        worldZ,
        draw: (g) => {
          drawRibbonQuad(g, q, fillColor, fillAlpha, strokeColor, strokeAlpha, q.tl.scale * nearBoost)
          if (energised) {
            // Glass-tube rails: trace the two side edges + a white core line so
            // the shape reads as a glowing hollow lamp, not a solid wall.
            g.moveTo(q.tl.x, q.tl.y)
            g.lineTo(q.bl.x, q.bl.y)
            g.moveTo(q.tr.x, q.tr.y)
            g.lineTo(q.br.x, q.br.y)
            g.stroke({
              color: 0xff88dd,
              width: Math.max(1.2, 3.5 * q.tl.scale * nearBoost),
              alpha: strokeAlpha * 0.8,
              cap: 'round',
            })
            g.moveTo((q.tl.x + q.tr.x) * 0.5, (q.tl.y + q.tr.y) * 0.5)
            g.lineTo((q.bl.x + q.br.x) * 0.5, (q.bl.y + q.br.y) * 0.5)
            g.stroke({
              color: 0xffffff,
              width: Math.max(1, 1.6 * q.tl.scale),
              alpha: strokeAlpha * 0.4,
              cap: 'round',
            })
          } else {
            g.moveTo(q.tl.x, q.tl.y)
            g.lineTo(q.tr.x, q.tr.y)
            g.stroke({
              color: fillColor,
              width: 7 * q.tl.scale * nearBoost,
              alpha: fillAlpha * 0.35,
              cap: 'round',
            })
          }
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

      // High-contrast "sky-pink vs seabed-green" hierarchy: floor pearls are
      // fluoro green with a HARD black outline so the pink slide's glow can
      // never wash them out. PURE flashes electric yellow.
      const noteState = this.groundNoteStates.get(b)
      let fillColor = hit ? 0x66ff99 : 0x00ff66
      let fillAlpha = hit ? 1 : 0.92
      if (noteState === 'pure') {
        fillColor = 0xffff00
        fillAlpha = 1
      } else if (noteState === 'far') {
        fillColor = 0xc8d8c0
        fillAlpha = 0.8
      } else if (noteState === 'lost') {
        fillColor = 0xff4040
        fillAlpha = 0.8
      }

      const w = (10 + p.scale * 12) * (node.type === 'hold' ? 1.5 : 1)
      const h = (5 + p.scale * 7) * (node.type === 'hold' ? 1 : 1)
      const outline = Math.max(2, 3 * p.scale)
      queue.push({
        worldZ,
        draw: (g) => {
          g.roundRect(p.x - w * 0.5, p.y - h, w, h, 2)
          g.fill({ color: fillColor, alpha: fillAlpha })
          // Hard black edge — the key to popping against the pink haze.
          g.stroke({ color: 0x000000, width: outline, alpha: 0.9 })
          if (noteState === 'pure') {
            g.circle(p.x, p.y - h * 0.5, w * 0.7)
            g.fill({ color: 0xffff00, alpha: 0.18 })
          }
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

  /**
   * Arcaea "juice" pass — drawn additively so everything reads as glowing light:
   *  1. The Hit Anchor at Z=0 (small/dim when idle; big, fluoro-pink, jittering
   *     halo when a finger is locked on).
   *  2. A neon energy tube tracing the ribbon centerline while energised.
   *  3. Electric tether arcs from the riding finger to the diver.
   */
  private drawSkyFx(dt: number, dyn: CameraDynamics): void {
    const g = this.fxGlow
    g.clear()
    const scroll = this.scrollBeats
    const tracked = this.skyArcGlowing

    // (2) Neon energy tube along the ribbon centerline while energised.
    if (tracked) {
      const pts: ProjectedPoint[] = []
      const maxBa = Math.min(8, this.maxBeatAhead())
      for (let ba = 0; ba <= maxBa; ba += 0.35) {
        const s = this.trackProvider.skyAtBeat(scroll + ba)
        const p = this.ps(s.x, s.y, ba, dyn)
        if (p) pts.push(p)
      }
      if (pts.length >= 2) {
        const layers: Array<[number, number, number]> = [
          [16, 0.1, 0xff33aa],
          [9, 0.18, 0xff88dd],
          [3.5, 0.55, 0xffffff],
        ]
        for (const [width, alpha, color] of layers) {
          g.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
          g.stroke({ color, width, alpha, cap: 'round', join: 'round' })
        }
      }
    }

    // (1) The Hit Anchor — while riding it is PINNED to the real fingertip so
    //     the player sees exactly where their finger sits vs the track (zero
    //     perceived latency, no visual lie); idle it falls back to the Z=0
    //     projection to show where to grab.
    const sky0 = this.trackProvider.skyAtBeat(scroll)
    // No anchor during a sky rest — the ribbon is intentionally broken there.
    const skyResting = this.trackProvider.getSkyNodeAtBeat(Math.floor(scroll)).type === 'rest'
    const anchor = skyResting ? null : this.ps(sky0.x, sky0.y, 0, dyn)
    // While riding, the reticle is WELDED 1:1 to the raw fingertip pixel — the
    // same point the diver is hard-snapped to — so the glowing array, the diver
    // centre and the physical fingertip are fused into one zero-latency point.
    let reticle: { x: number; y: number } | null = anchor
    if (tracked && this.skyTrackPointer) {
      reticle = this.skyTrackPointer
    }
    if (reticle) {
      const pulse = 0.5 + 0.5 * Math.sin(this.ribbonTime * 6)
      if (tracked) {
        // High-frequency radiating micro-jitter — "finger is in the array core".
        const cx = reticle.x + (Math.random() - 0.5) * 4
        const cy = reticle.y + (Math.random() - 0.5) * 4
        const base = 26 * 1.2
        // shadowBlur emulation: stacked translucent halos.
        const halos: Array<[number, number]> = [
          [base * 1.7, 0.12],
          [base * 1.15, 0.22],
          [base * 0.7, 0.5],
        ]
        for (const [r, a] of halos) {
          g.circle(cx, cy, r)
          g.fill({ color: 0xff66cc, alpha: a })
        }
        g.circle(cx, cy, base + pulse * 5)
        g.stroke({ color: 0xffffff, width: 3, alpha: 0.95 })
        // Radiating spokes for an energised "law array" look.
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2 + this.ribbonTime * 2
          const r0 = base * 0.8
          const r1 = base * (1.3 + Math.random() * 0.4)
          g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0)
          g.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1)
          g.stroke({ color: 0xffaaee, width: 1.5, alpha: 0.5 })
        }
      } else {
        // Idle: small dim guide ring.
        g.circle(reticle.x, reticle.y, 16 + pulse * 4)
        g.stroke({ color: 0x6aa0c8, width: 2, alpha: 0.4 })
        g.circle(reticle.x, reticle.y, 5)
        g.fill({ color: 0x9cc8e0, alpha: 0.3 })
      }
    }

    // (3) Electric tether: finger → diver, while riding.
    if (tracked && this.skyTrackPointer) {
      const a = this.skyTrackPointer
      const b = this.lastPengPose
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const px = -dy / len
      const py = dx / len
      const seg = 7
      const strands: Array<[number, number, number]> = [
        [2.6, 0.9, 0xffffff],
        [1.3, 0.55, 0xff99dd],
        [1.0, 0.4, 0x99ddff],
      ]
      for (let s = 0; s < strands.length; s++) {
        const [width, alpha, color] = strands[s]
        g.moveTo(a.x, a.y)
        for (let i = 1; i <= seg; i++) {
          const t = i / seg
          const taper = 1 - Math.abs(t - 0.5) * 2
          const noise =
            Math.sin(t * Math.PI * 3 + this.ribbonTime * 32 + s * 2.1) * taper * 16 +
            (Math.random() - 0.5) * 5
          const bx = a.x + dx * t + px * noise
          const by = a.y + dy * t + py * noise
          g.lineTo(bx, by)
        }
        g.stroke({ color, width, alpha, cap: 'round', join: 'round' })
      }
    }

    // (4) Juice particles: burning-edge cavitation at the contact point +
    //     reward pearls homing from the fingertip into the diver's body.
    this.skyJuice.update(dt, {
      tracked,
      anchorX: anchor ? anchor.x : 0,
      anchorY: anchor ? anchor.y : 0,
      anchorValid: !!anchor,
      fingerX: this.skyTrackPointer ? this.skyTrackPointer.x : 0,
      fingerY: this.skyTrackPointer ? this.skyTrackPointer.y : 0,
      fingerValid: !!this.skyTrackPointer,
      pengX: this.lastPengPose.x,
      pengY: this.lastPengPose.y,
    })
    this.skyJuice.draw(g)

    // (5) Read-ahead beacons for each upcoming arc HEAD (first beat after a
    //     rest) so the player can pre-read where/when the next slide lifts off.
    this.drawSkyHeads(scroll, dyn)
  }

  /**
   * Draw a vertical seabed drop-guide + a glowing diamond "energy core" at the
   * head of every approaching arc segment (the first non-rest beat following a
   * rest). Painted additively on {@link fxGlow}.
   */
  private drawSkyHeads(scroll: number, dyn: CameraDynamics): void {
    const g = this.fxGlow
    const halfWidth = this.transform.trackHalfWidth
    const maxBa = Math.min(8, this.maxBeatAhead())

    for (let b = Math.floor(scroll); b <= scroll + maxBa; b++) {
      const here = this.trackProvider.getSkyNodeAtBeat(b)
      const prev = this.trackProvider.getSkyNodeAtBeat(b - 1)
      // A head = arc beat immediately preceded by a rest beat.
      if (here.type === 'rest' || prev.type !== 'rest') continue

      const beatAhead = b - scroll
      if (beatAhead < -0.1 || beatAhead > maxBa) continue

      const s = this.trackProvider.skyAtBeat(b)
      const worldZ = this.transform.beatAheadToZ(beatAhead)
      const wave = waveOffsetX(worldZ, this.ribbonTime, halfWidth)
      const wx = s.x * halfWidth + wave
      const top = this.transform.project(wx, this.transform.skyChartYToWorldY(s.y), worldZ, dyn)
      const bottom = this.transform.project(wx, 0, worldZ, dyn)
      if (!top || !bottom) continue

      const fade = 1 - (top.fog ?? 0) * 0.6

      // --- Streamlined funnel CAP: a filled "trumpet mouth" that grows out of
      //     the rotating core and opens into the ribbon body as it runs into the
      //     depths (~0.6 beat). Narrow (hugging the core) → wide, so the head
      //     reads as an energy crystal the ribbon is streaming out of, with no
      //     hard rectangular break. ---
      const coreMouthR = (6 + top.scale * 10) * 0.32
      let capPrev = top
      let capPrevW = coreMouthR
      const capDf = [0.2, 0.4, 0.6]
      for (let si = 0; si < capDf.length; si++) {
        const df = capDf[si]
        const sd = this.trackProvider.skyAtBeat(b + df)
        const zd = this.transform.beatAheadToZ(beatAhead + df)
        const wd = waveOffsetX(zd, this.ribbonTime, halfWidth)
        const pd = this.transform.project(
          sd.x * halfWidth + wd,
          this.transform.skyChartYToWorldY(sd.y),
          zd,
          dyn,
        )
        if (!pd) break
        // Opening width grows away from the core, then eases as depth shrinks it.
        const openW = (6 + top.scale * 10) * (0.5 + si * 0.4)
        const sdx = pd.x - capPrev.x
        const sdy = pd.y - capPrev.y
        const sl = Math.hypot(sdx, sdy) || 1
        const nx = -sdy / sl
        const ny = sdx / sl
        // Tapering trapezoid slice of the funnel.
        g.moveTo(capPrev.x + nx * capPrevW, capPrev.y + ny * capPrevW)
        g.lineTo(pd.x + nx * openW, pd.y + ny * openW)
        g.lineTo(pd.x - nx * openW, pd.y - ny * openW)
        g.lineTo(capPrev.x - nx * capPrevW, capPrev.y - ny * capPrevW)
        g.closePath()
        const a = (0.22 - si * 0.05) * fade
        g.fill({ color: 0x40e0ff, alpha: a })
        // Edge rails that visually pinch inward to wrap the core.
        g.moveTo(capPrev.x + nx * capPrevW, capPrev.y + ny * capPrevW)
        g.lineTo(pd.x + nx * openW, pd.y + ny * openW)
        g.moveTo(capPrev.x - nx * capPrevW, capPrev.y - ny * capPrevW)
        g.lineTo(pd.x - nx * openW, pd.y - ny * openW)
        g.stroke({ color: 0x9fe8ff, width: Math.max(1, 1.5 * top.scale), alpha: 0.5 * fade, cap: 'round' })
        capPrev = pd
        capPrevW = openW
      }

      // --- Vertical seabed drop-guide (manual dashes; Pixi has no lineDash).
      //     Gradient emulated per-dash: bright cyan at the head, fading down. ---
      const dx = top.x - bottom.x
      const dy = top.y - bottom.y
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len
      const uy = dy / len
      for (let d = 0; d < len; d += 10) {
        const e = Math.min(d + 4, len)
        const heightT = d / len // 0 seabed → 1 head
        g.moveTo(bottom.x + ux * d, bottom.y + uy * d)
        g.lineTo(bottom.x + ux * e, bottom.y + uy * e)
        g.stroke({ color: 0x66ccff, width: 1.5, alpha: (0.12 + 0.6 * heightT) * fade })
      }
      // Seabed drop-footprint: faint disc + ring so a glance locks the head's
      // exact horizontal lane on the floor grid.
      g.circle(bottom.x, bottom.y, 3 + 2 * top.scale)
      g.fill({ color: 0x66ccff, alpha: 0.12 * fade })
      g.circle(bottom.x, bottom.y, 5 + 3 * top.scale)
      g.stroke({ color: 0x9fe0ff, width: 1.2, alpha: 0.5 * fade })

      // --- Glowing diamond energy core at the air-start head. ---
      const coreR = 6 + top.scale * 10
      // Ramps in over the final ~2 beats of approach.
      const approach = Math.max(0, Math.min(1, 1 - beatAhead / 2))
      const halos: Array<[number, number]> = [
        [coreR * 2.4, 0.1],
        [coreR * 1.5, 0.18],
        [coreR * 0.9, 0.42],
      ]
      for (const [r, a] of halos) {
        g.circle(top.x, top.y, r)
        g.fill({ color: 0xff66cc, alpha: a * (0.5 + approach * 0.5) * fade })
      }
      const rot = this.ribbonTime * 2
      this.drawDiamond(g, top.x, top.y, coreR, rot, 0x8efcff, 0.9 * fade)
      this.drawDiamond(g, top.x, top.y, coreR * 0.8, -rot + Math.PI / 4, 0xff8ad8, 0.85 * fade)
      // Cross star-flare.
      for (let i = 0; i < 4; i++) {
        const ang = i * (Math.PI / 2) + rot * 0.5
        g.moveTo(top.x, top.y)
        g.lineTo(top.x + Math.cos(ang) * coreR * 2.2, top.y + Math.sin(ang) * coreR * 2.2)
        g.stroke({ color: 0xffffff, width: 1.5, alpha: 0.5 * approach * fade })
      }
      // Burst ring the instant the head crosses the Z=0 judge plane.
      if (beatAhead < 0.18) {
        const t = 1 - beatAhead / 0.18
        g.circle(top.x, top.y, coreR * (1 + t * 2.5))
        g.stroke({ color: 0xffffff, width: 2.5 * (1 - t), alpha: 0.9 * (1 - t) })
      }
    }
  }

  /** Filled+outlined diamond rotated by `rot` (radians) — head-core glyph. */
  private drawDiamond(
    g: Graphics,
    cx: number,
    cy: number,
    r: number,
    rot: number,
    color: number,
    alpha: number,
  ): void {
    const c = Math.cos(rot)
    const s = Math.sin(rot)
    // Diamond corners (0,-r)(r,0)(0,r)(-r,0) rotated by `rot`.
    g.moveTo(cx - -r * s, cy + -r * c)
    g.lineTo(cx + r * c, cy + r * s)
    g.lineTo(cx - r * s, cy + r * c)
    g.lineTo(cx + -r * c, cy + -r * s)
    g.closePath()
    g.fill({ color, alpha: alpha * 0.5 })
    g.stroke({ color: 0xffffff, width: 1.4, alpha })
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
