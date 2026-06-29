import { Graphics } from 'pixi.js'
import type { CameraDynamics, ProjectedPoint, Transform3D } from './Transform3D'

const REEF_COLOR = 0x051416
const REEF_COUNT = 14

interface ReefChunk {
  x: number
  y: number
  z: number
  w: number
  h: number
  depth: number
  seed: number
}

/**
 * Scrolling reef silhouettes on both canyon walls — Z-streamed past the player
 * to sell forward speed through a narrow trench.
 */
export class CanyonReefField {
  private readonly chunks: ReefChunk[] = []
  private seeded = false

  reset(): void {
    this.chunks.length = 0
    this.seeded = false
  }

  ensureSeeded(transform: Transform3D): void {
    if (this.seeded) return
    this.seeded = true
    const zMax = transform.zSpawn
    for (let i = 0; i < REEF_COUNT; i++) {
      this.chunks.push(this.spawnChunk(transform, Math.random() * zMax))
    }
  }

  update(dz: number, transform: Transform3D): void {
    this.ensureSeeded(transform)
    for (const c of this.chunks) {
      c.z -= dz
      if (c.z < -60) {
        Object.assign(c, this.spawnChunk(transform, transform.zSpawn + Math.random() * 320))
      }
    }
  }

  draw(g: Graphics, transform: Transform3D, dyn: CameraDynamics): void {
    const sorted = [...this.chunks].sort((a, b) => b.z - a.z)
    for (const c of sorted) {
      this.drawChunk(g, transform, dyn, c)
    }
  }

  private spawnChunk(transform: Transform3D, z: number): ReefChunk {
    const side = Math.random() < 0.5 ? -1 : 1
    const lane = transform.trackHalfWidth
    return {
      x: side * (lane * 1.05 + 40 + Math.random() * 90),
      y: Math.random() * 55,
      z,
      w: 55 + Math.random() * 110,
      h: 70 + Math.random() * 160,
      depth: 0.35 + Math.random() * 0.65,
      seed: Math.random() * 997,
    }
  }

  private drawChunk(
    g: Graphics,
    transform: Transform3D,
    dyn: CameraDynamics,
    c: ReefChunk,
  ): void {
    const base = transform.project(c.x, c.y, c.z, dyn)
    const top = transform.project(c.x, c.y + c.h, c.z, dyn)
    const far = transform.project(c.x + c.w * Math.sign(c.x || 1), c.y + c.h * 0.35, c.z, dyn)
    if (!base || !top || !far) return

    const alpha = Math.min(0.92, 0.18 + c.depth * 0.55) * (1 - base.fog * 0.35)
    const bulge = Math.sin(c.seed * 3.7) * base.scale * 8

    g.moveTo(base.x, base.y)
    g.lineTo(top.x, top.y)
    g.quadraticCurveTo(far.x + bulge, (top.y + far.y) * 0.5, far.x, far.y)
    g.lineTo(base.x + Math.sign(c.x) * base.scale * 12, base.y)
    g.closePath()
    g.fill({ color: REEF_COLOR, alpha })

    g.moveTo(top.x, top.y)
    g.lineTo(top.x + Math.sign(c.x) * base.scale * 6, top.y - base.scale * 4)
    g.stroke({ color: 0x0a2428, width: Math.max(0.6, base.scale * 0.05), alpha: alpha * 0.5 })
  }
}
