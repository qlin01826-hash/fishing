import type { CameraDynamics } from './Transform3D'
import { Transform3D } from './Transform3D'
import type { TrackSplineProvider } from './TrackSplineProvider'

interface Boid {
  worldX: number
  worldY: number
  worldZ: number
  vx: number
  vy: number
  vz: number
  side: number
  life: number
}

export class BoidsFishSwarm {
  private readonly boids: Boid[] = []
  private flowState: 'Gaps_Escort' | 'Beat_Evacuation' = 'Gaps_Escort'
  private intensity = 0

  setFlowState(state: 'Gaps_Escort' | 'Beat_Evacuation', intensity: number): void {
    this.flowState = state
    this.intensity = intensity
  }

  update(
    dt: number,
    scrollBeats: number,
    track: TrackSplineProvider,
    transform: Transform3D,
    dyn: CameraDynamics,
  ): void {
    const evac = this.flowState === 'Beat_Evacuation'
    const targetCount = evac ? 0 : Math.floor(24 + this.intensity * 46)

    while (this.boids.length < targetCount && !evac) {
      const side = Math.random() > 0.5 ? 1 : -1
      const z = transform.beatAheadToZ(2 + Math.random() * 6)
      this.boids.push({
        worldX: side * transform.trackHalfWidth * (1.1 + Math.random() * 0.4),
        worldY: 15 + Math.random() * 40,
        worldZ: z,
        vx: 0,
        vy: 0,
        vz: 0,
        side,
        life: 1,
      })
    }

    const anchor = track.skyWorldAtBeat(scrollBeats, scrollBeats)

    for (let i = this.boids.length - 1; i >= 0; i--) {
      const b = this.boids[i]
      if (evac) {
        b.vx += b.side * 120 * dt
        b.life -= dt * 2.2
      } else {
        b.worldZ = Math.max(Transform3D.Z_JUDGE + 20, b.worldZ - 25 * dt)
        const tx = anchor.x + b.side * transform.trackHalfWidth * 0.75
        const ty = anchor.y + 20 + Math.sin(scrollBeats * 2 + i) * 15
        const tz = anchor.z + 40
        b.vx += (tx - b.worldX) * 3 * dt
        b.vy += (ty - b.worldY) * 3 * dt
        b.vz += (tz - b.worldZ) * 2 * dt
      }
      b.vx *= 0.88
      b.vy *= 0.88
      b.vz *= 0.9
      b.worldX += b.vx * dt
      b.worldY += b.vy * dt
      b.worldZ += b.vz * dt
      if (b.life <= 0 || evac && Math.abs(b.worldX) > transform.trackHalfWidth * 2.5) {
        this.boids.splice(i, 1)
      }
    }
    void dyn
  }

  draw(g: import('pixi.js').Graphics, transform: Transform3D, dyn: CameraDynamics, tint: number): void {
    // Painter order, far first — sort the live array in place (no per-frame
    // wrapper-array/map/filter allocations). Sim order is irrelevant.
    this.boids.sort((a, c) => c.worldZ - a.worldZ)

    for (const b of this.boids) {
      const p = transform.project(b.worldX, b.worldY, b.worldZ, dyn)
      if (!p) continue
      const a = b.life * 0.7 * (1 - p.fog * 0.5)
      const rx = 5 * p.scale
      const ry = 2 * p.scale
      g.ellipse(p.x, p.y, rx, ry)
      g.fill({ color: tint, alpha: a })
      g.ellipse(p.x - rx * 0.6, p.y, rx * 0.35, ry * 0.5)
      g.fill({ color: 0xf0f8ff, alpha: a * 0.5 })
    }
  }

  clear(): void {
    this.boids.length = 0
  }
}
