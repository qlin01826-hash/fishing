import { Container, Graphics } from 'pixi.js'
import type { CameraDynamics, ProjectedPoint, Transform3D } from './Transform3D'
import { Vector3 } from './math/Vector3'

const DEG = Math.PI / 180
const ROLL_CLAMP = 25 * DEG
const PITCH_CLAMP = 12 * DEG
/** Streamlined dive pose — belly down, beak aimed into the depth highway. */
const BASE_PITCH = -30 * DEG

interface ZCavBubble {
  ox: number
  oy: number
  oz: number
  life: number
  size: number
}

interface WingTipLocal {
  x: number
  y: number
}

/**
 * Chase penguin — pitched dive pose, procedural wing flapping, Z-streamed
 * cavitation trails welded to forward speed.
 */
export class PenguinChaseRenderer {
  readonly container = new Container()
  private readonly bodyPivot = new Container()
  private readonly g = new Graphics()
  private readonly cavG = new Graphics()
  private readonly zCavitation: ZCavBubble[] = []
  lastBodyScreen: ProjectedPoint | null = null

  private wingTipsLocal: { left: WingTipLocal | null; right: WingTipLocal | null } = {
    left: null,
    right: null,
  }

  constructor() {
    this.bodyPivot.addChild(this.g)
    this.container.addChild(this.cavG, this.bodyPivot)
  }

  clear(): void {
    this.g.clear()
    this.cavG.clear()
    this.zCavitation.length = 0
    this.lastBodyScreen = null
    this.bodyPivot.position.set(0, 0)
    this.bodyPivot.rotation = 0
  }

  drawShadow(
    g: Graphics,
    transform: Transform3D,
    dyn: CameraDynamics,
    center: Vector3,
  ): void {
    const ground = transform.project(center.x, 0, center.z, dyn)
    if (!ground) return
    const height = Math.max(0, center.y)
    const spread = ground.scale * (1.35 + height * 0.012)
    const alpha = Math.max(0.06, Math.min(0.52, 0.55 - height * 0.0028))
    g.ellipse(ground.x, ground.y, spread * 1.15, spread * 0.38)
    g.fill({ color: 0x020608, alpha: alpha * 0.85 })
    g.ellipse(ground.x, ground.y, spread * 0.72, spread * 0.22)
    g.fill({ color: 0x081018, alpha: alpha * 0.45 })
  }

  draw(
    dt: number,
    transform: Transform3D,
    dyn: CameraDynamics,
    center: Vector3,
    roll: number,
    pitch: number,
    bankIntensity: number,
    tapPulse: number,
    nowMs: number,
  ): void {
    void tapPulse
    const rollAngle = clamp(roll, -ROLL_CLAMP, ROLL_CLAMP)
    const flowPitch = clamp(pitch, -PITCH_CLAMP, PITCH_CLAMP)
    const divePitch = BASE_PITCH + flowPitch * 0.35
    const flap = Math.sin(nowMs * 0.02) * 20

    const bodyProj = transform.project(center.x, center.y, center.z, dyn)
    if (!bodyProj) {
      this.g.clear()
      this.cavG.clear()
      return
    }
    this.lastBodyScreen = bodyProj

    const s = bodyProj.scale
    this.bodyPivot.position.set(bodyProj.x, bodyProj.y)
    this.bodyPivot.rotation = divePitch + rollAngle * 0.08

    const bellyOffsetX = Math.sin(rollAngle) * 12 * (s / 10)
    const beakOffsetX = Math.sin(rollAngle) * 18 * (s / 10)
    const bellyOffsetY = Math.sin(flowPitch) * 3 * (s / 10)

    const bodyRx = 24 * s
    const bodyRy = 20 * s
    const bellyRx = 15 * s
    const bellyRy = 13 * s

    const bankSign = rollAngle > 0.04 ? 1 : rollAngle < -0.04 ? -1 : 0
    const leftTucked = bankSign > 0
    const rightTucked = bankSign < 0

    this.g.clear()
    this.wingTipsLocal.left = null
    this.wingTipsLocal.right = null

    if (leftTucked) {
      this.drawWing(s, true, flap, bankIntensity, true)
    } else if (rightTucked) {
      this.drawWing(s, false, flap, bankIntensity, true)
    }

    this.drawBodyBack(0, 0, bodyRx, bodyRy)
    this.drawBelly(bellyOffsetX, bellyOffsetY + s * 1.5, bellyRx, bellyRy)

    if (leftTucked) {
      this.drawWing(s, false, -flap, bankIntensity, false)
    } else if (rightTucked) {
      this.drawWing(s, true, flap, bankIntensity, false)
    } else {
      this.drawWing(s, true, flap, bankIntensity, false)
      this.drawWing(s, false, -flap, bankIntensity, false)
    }

    this.drawEye(-7 * s + bellyOffsetX * 0.2, -8 * s, 4 * s)
    this.drawEye(7 * s + bellyOffsetX * 0.2, -8 * s, 4 * s)
    this.drawBeak(beakOffsetX, -2 * s + bellyOffsetY * 0.35, s)

    this.spawnZCavitation(center, rollAngle, bankIntensity)
    this.updateZCavitation(dt, transform, dyn, center)
    this.drawZCavitation(transform, dyn, center)
  }

  private drawBodyBack(cx: number, cy: number, rx: number, ry: number): void {
    const g = this.g
    g.ellipse(cx, cy, rx, ry)
    g.fill({ color: 0x080810, alpha: 0.98 })
    g.ellipse(cx - rx * 0.34, cy - ry * 0.4, rx * 0.5, ry * 0.44)
    g.fill({ color: 0x2a2a38, alpha: 0.58 })
    g.ellipse(cx - rx * 0.2, cy - ry * 0.24, rx * 0.36, ry * 0.3)
    g.fill({ color: 0x505060, alpha: 0.38 })
    g.ellipse(cx + rx * 0.14, cy + ry * 0.22, rx * 0.7, ry * 0.55)
    g.fill({ color: 0x000000, alpha: 0.24 })
  }

  private drawBelly(bx: number, by: number, rx: number, ry: number): void {
    const g = this.g
    g.ellipse(bx, by, rx, ry)
    g.fill({ color: 0xe8ecf0, alpha: 0.96 })
    g.ellipse(bx - rx * 0.14, by - ry * 0.18, rx * 0.52, ry * 0.42)
    g.fill({ color: 0xffffff, alpha: 0.74 })
  }

  private drawWing(
    s: number,
    left: boolean,
    flap: number,
    bankIntensity: number,
    tucked: boolean,
  ): void {
    const side = left ? -1 : 1
    const flapY = flap * (s / 10)
    const rootX = side * s * 18
    const rootY = s * 2 + flapY * 0.12

    let tipX: number
    let tipY: number
    let heelX: number
    let heelY: number

    if (tucked) {
      tipX = side * s * 12
      tipY = -s * 20 * (0.55 + bankIntensity * 0.45) + flapY * 0.15
      heelX = side * s * 7
      heelY = s * 8
    } else {
      tipX = side * s * 40 + flapY * side * 0.08
      tipY = -s * 4 + flapY * side * 0.55
      heelX = side * s * 24
      heelY = s * 16 + flapY * 0.2
    }

    const g = this.g
    g.moveTo(rootX, rootY)
    g.lineTo(tipX, tipY)
    g.lineTo(heelX, heelY)
    g.closePath()
    g.fill({ color: tucked ? 0x121218 : 0x1c1c26, alpha: 0.94 })
    g.stroke({ color: 0x3a3a48, width: Math.max(0.8, s * 0.04), alpha: 0.5 })

    if (!tucked) {
      const tip = { x: tipX, y: tipY }
      if (side < 0) this.wingTipsLocal.left = tip
      else this.wingTipsLocal.right = tip
    }
  }

  private drawEye(ex: number, ey: number, r: number): void {
    const g = this.g
    g.circle(ex, ey, r)
    g.fill({ color: 0xffffff, alpha: 0.98 })
    g.circle(ex + r * 0.1, ey + r * 0.06, r * 0.45)
    g.fill({ color: 0x111118, alpha: 0.95 })
  }

  private drawBeak(bx: number, by: number, s: number): void {
    const g = this.g
    const w = 3.8 * s
    g.moveTo(bx - w, by)
    g.lineTo(bx + w, by)
    g.lineTo(bx, by - 7 * s)
    g.closePath()
    g.fill({ color: 0xffa030, alpha: 0.96 })
    g.stroke({ color: 0xc86810, width: Math.max(0.8, s * 0.04), alpha: 0.7 })
  }

  private spawnZCavitation(center: Vector3, roll: number, bankIntensity: number): void {
    const tips: WingTipLocal[] = []
    if (this.wingTipsLocal.left) tips.push(this.wingTipsLocal.left)
    if (this.wingTipsLocal.right) tips.push(this.wingTipsLocal.right)
    if (tips.length === 0) return

    const total = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < total; i++) {
      const tip = tips[i % tips.length]
      this.zCavitation.push({
        ox: tip.x + (Math.random() - 0.5) * 5,
        oy: tip.y + (Math.random() - 0.5) * 5,
        oz: 4 + Math.random() * 10 + Math.abs(roll) * 6,
        life: 0.45 + Math.random() * 0.35,
        size: 1.2 + Math.random() * 1.8,
      })
    }
    void center
    void bankIntensity
    if (this.zCavitation.length > 80) {
      this.zCavitation.splice(0, this.zCavitation.length - 80)
    }
  }

  private updateZCavitation(
    dt: number,
    transform: Transform3D,
    dyn: CameraDynamics,
    center: Vector3,
  ): void {
    const retreat = 420 * dt
    for (let i = this.zCavitation.length - 1; i >= 0; i--) {
      const b = this.zCavitation[i]
      b.oz += retreat
      b.life -= dt * 1.6
      if (b.life <= 0 || b.oz > transform.zSpawn) {
        this.zCavitation.splice(i, 1)
      }
    }
    void transform
    void dyn
    void center
  }

  private drawZCavitation(
    transform: Transform3D,
    dyn: CameraDynamics,
    center: Vector3,
  ): void {
    const g = this.cavG
    g.clear()
    const cosR = Math.cos(this.bodyPivot.rotation)
    const sinR = Math.sin(this.bodyPivot.rotation)

    for (const b of this.zCavitation) {
      const lx = b.ox * cosR - b.oy * sinR
      const ly = b.ox * sinR + b.oy * cosR
      const wx = center.x + lx
      const wy = center.y + ly
      const wz = center.z + b.oz
      const p = transform.project(wx, wy, wz, dyn)
      if (!p) continue
      const r = b.size * (0.35 + p.scale * 0.04) * b.life
      g.circle(p.x, p.y, r)
      g.fill({ color: 0xe8f8ff, alpha: b.life * 0.42 })
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
