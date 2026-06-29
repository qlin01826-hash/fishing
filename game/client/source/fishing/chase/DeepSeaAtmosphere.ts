import { Container, Graphics } from 'pixi.js'
import type { CameraDynamics, Transform3D } from './Transform3D'

const TOP_COLOR = 0x0c2b2d
const BOT_COLOR = 0x030a10
const GRAD_BANDS = 36
const SNOW_COUNT = 40

interface ZSnowParticle {
  x: number
  y: number
  z: number
  r: number
  alpha: number
  phase: number
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function lerpColor(from: number, to: number, t: number): number {
  return (
    (lerpChannel((from >> 16) & 0xff, (to >> 16) & 0xff, t) << 16) |
    (lerpChannel((from >> 8) & 0xff, (to >> 8) & 0xff, t) << 8) |
    lerpChannel(from & 0xff, to & 0xff, t)
  )
}

/**
 * Deep-sea backdrop with Z-streamed marine snow (medium rushing past the camera).
 */
export class DeepSeaAtmosphere {
  readonly container = new Container()
  private readonly bg = new Graphics()
  private readonly lightRays = new Graphics()
  private readonly fog = new Graphics()
  private readonly snow = new Graphics()
  private readonly particles: ZSnowParticle[] = []
  private width = 844
  private height = 390
  private time = 0
  private zSpawn = 1200
  private trackHalfWidth = 210

  constructor() {
    this.lightRays.blendMode = 'screen'
    this.snow.blendMode = 'screen'
    this.container.addChild(this.bg, this.lightRays, this.fog, this.snow)
    this.seedParticles()
  }

  resize(width: number, height: number, transform?: Transform3D): void {
    this.width = width
    this.height = height
    if (transform) {
      this.zSpawn = transform.zSpawn
      this.trackHalfWidth = transform.trackHalfWidth
    }
    this.seedParticles()
  }

  reset(): void {
    this.time = 0
    this.seedParticles()
  }

  update(dt: number, ribbonTime: number, dz: number, transform: Transform3D): void {
    this.time += dt
    const sway = Math.sin(ribbonTime * 3.2) * 18 * dt
    for (const p of this.particles) {
      p.z -= dz
      p.x += Math.sin(this.time * 0.45 + p.phase) * sway
      if (p.z < -30) {
        Object.assign(p, this.spawnParticle())
      }
    }
  }

  draw(
    vanishY: number,
    nowMs: number,
    transform: Transform3D,
    dyn: CameraDynamics,
  ): void {
    const w = this.width
    const h = this.height
    const cx = w * 0.5
    const breath = Math.sin(nowMs * 0.001) * 0.05

    this.drawVerticalGradient(w, h)
    this.drawSoftLightRays(cx, vanishY, w, h, breath)
    this.drawDistanceFog(cx, vanishY, w, h)
    this.drawMarineSnow(transform, dyn)
  }

  private seedParticles(): void {
    this.particles.length = 0
    for (let i = 0; i < SNOW_COUNT; i++) {
      this.particles.push(this.spawnParticle())
    }
  }

  private spawnParticle(): ZSnowParticle {
    const hw = this.trackHalfWidth * 1.6
    return {
      x: (Math.random() - 0.5) * hw * 2.2,
      y: Math.random() * 120,
      z: Math.random() * this.zSpawn,
      r: 1 + Math.random(),
      alpha: 0.12 + Math.random() * 0.22,
      phase: Math.random() * Math.PI * 2,
    }
  }

  private drawVerticalGradient(w: number, h: number): void {
    const g = this.bg
    g.clear()
    const bandH = h / GRAD_BANDS + 1
    for (let i = 0; i < GRAD_BANDS; i++) {
      const t = i / (GRAD_BANDS - 1)
      g.rect(0, i * (h / GRAD_BANDS), w, bandH)
      g.fill({ color: lerpColor(TOP_COLOR, BOT_COLOR, t) })
    }
  }

  private drawSoftLightRays(
    cx: number,
    vanishY: number,
    w: number,
    h: number,
    breath: number,
  ): void {
    const g = this.lightRays
    g.clear()
    const anchorY = Math.max(0, vanishY - h * 0.06)

    for (let i = 0; i < 6; i++) {
      const spread = 55 + i * 32
      const alpha = Math.max(0.02, 0.045 + i * 0.012 + breath)
      const yOff = anchorY + i * 8
      g.ellipse(cx, yOff, spread * 0.55, anchorY + h * 0.42)
      g.fill({ color: 0xc8e8b0, alpha: alpha * 0.35 })

      g.moveTo(cx - spread * 0.12, 0)
      g.quadraticCurveTo(cx - spread * 0.55, anchorY * 0.55, cx - spread, yOff + h * 0.38)
      g.quadraticCurveTo(cx - spread * 0.35, yOff + h * 0.22, cx - spread * 0.08, 0)
      g.closePath()
      g.fill({ color: 0xd8f0c8, alpha: alpha * 0.55 })

      g.moveTo(cx + spread * 0.12, 0)
      g.quadraticCurveTo(cx + spread * 0.55, anchorY * 0.55, cx + spread, yOff + h * 0.38)
      g.quadraticCurveTo(cx + spread * 0.35, yOff + h * 0.22, cx + spread * 0.08, 0)
      g.closePath()
      g.fill({ color: 0xd8f0c8, alpha: alpha * 0.55 })
    }

    g.ellipse(cx, anchorY + h * 0.08, w * 0.22, h * 0.18)
    g.fill({ color: 0xe8ffe0, alpha: 0.04 + breath * 0.5 })
    void w
  }

  private drawDistanceFog(cx: number, vanishY: number, w: number, h: number): void {
    const g = this.fog
    g.clear()
    g.rect(0, 0, w, h)
    g.fill({ color: 0x000000, alpha: 0.05 })

    g.moveTo(cx, vanishY)
    g.quadraticCurveTo(cx - w * 0.22, vanishY + h * 0.18, cx - w * 0.14, h)
    g.lineTo(cx + w * 0.14, h)
    g.quadraticCurveTo(cx + w * 0.22, vanishY + h * 0.18, cx, vanishY)
    g.closePath()
    g.fill({ color: 0x061018, alpha: 0.28 })

    g.ellipse(cx, vanishY + h * 0.08, w * 0.38, h * 0.22)
    g.fill({ color: 0x0a2830, alpha: 0.12 })
  }

  private drawMarineSnow(transform: Transform3D, dyn: CameraDynamics): void {
    const g = this.snow
    g.clear()
    const sorted = [...this.particles].sort((a, b) => b.z - a.z)
    for (const p of sorted) {
      const proj = transform.project(p.x, p.y, p.z, dyn)
      if (!proj) continue
      const r = p.r * (0.5 + proj.scale * 0.06)
      g.circle(proj.x, proj.y, r)
      g.fill({ color: 0xffffff, alpha: p.alpha * (1 - proj.fog * 0.4) })
    }
  }
}
