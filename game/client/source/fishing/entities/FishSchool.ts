import { Container, Graphics } from 'pixi.js'
import type { FishDef, ViewportContext } from '../types'
import { FISH_CATALOG } from '../data/FishCatalog'

interface AmbientFish {
  def: FishDef
  graphic: Graphics
  x: number
  y: number
  vx: number
  scale: number
  phase: number
}

/**
 * Background fish that lazily swim across the depth bands. They are
 * cosmetic until one of them is selected as a "biter" by the scene —
 * at which point the scene asks the school for a candidate fish near
 * the hook.
 */
export class FishSchool {
  readonly container = new Container()
  private fish: AmbientFish[] = []
  private viewport: ViewportContext
  private spawnAccumulator = 0

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    for (const f of this.fish) {
      // Re-clamp Y to remain in the available depth column on resize
      const minY = viewport.waterLineY + 12
      const maxY = viewport.waterLineY + viewport.maxDepth - 12
      if (f.y < minY) f.y = minY
      if (f.y > maxY) f.y = maxY
    }
  }

  update(dtSeconds: number, hungerIntensity: number): void {
    this.spawnAccumulator += dtSeconds
    const target = 8 + Math.floor(hungerIntensity * 12)
    if (this.spawnAccumulator > 0.8 && this.fish.length < target) {
      this.spawn(hungerIntensity)
      this.spawnAccumulator = 0
    }
    for (let i = this.fish.length - 1; i >= 0; i -= 1) {
      const f = this.fish[i]
      f.x += f.vx * dtSeconds
      f.phase += dtSeconds * 4
      f.y += Math.sin(f.phase) * 0.4
      const offscreenLeft = f.vx < 0 && f.x < -40
      const offscreenRight = f.vx > 0 && f.x > this.viewport.width + 40
      if (offscreenLeft || offscreenRight) {
        f.graphic.destroy()
        this.fish.splice(i, 1)
        continue
      }
      f.graphic.position.set(f.x, f.y)
      f.graphic.scale.x = f.vx > 0 ? f.scale : -f.scale
    }
  }

  /**
   * Pick a fish near the hook to be the biter. Returns the chosen
   * ambient fish (for visual highlight) along with its def.
   */
  pickNearestFish(hookX: number, hookY: number, maxDistance = 220): { fish: AmbientFish; def: FishDef } | null {
    let best: AmbientFish | null = null
    let bestDist = Infinity
    for (const f of this.fish) {
      const d = Math.hypot(f.x - hookX, f.y - hookY)
      if (d < bestDist && d < maxDistance) {
        best = f
        bestDist = d
      }
    }
    if (!best) return null
    return { fish: best, def: best.def }
  }

  /** Remove a specific fish (e.g. when caught or escaped). */
  remove(fish: AmbientFish): void {
    const index = this.fish.indexOf(fish)
    if (index >= 0) {
      fish.graphic.destroy()
      this.fish.splice(index, 1)
    }
  }

  /** Force-spawn one fish near the hook (used when no fish are close). */
  spawnNear(hookX: number, hookY: number, def: FishDef): { fish: AmbientFish; def: FishDef } {
    const fish = this.makeFish(def, hookX + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 60), hookY)
    this.container.addChild(fish.graphic)
    this.fish.push(fish)
    return { fish, def }
  }

  /** Drive a single fish (used during battle "follow fish"). */
  moveFish(fish: AmbientFish, dx: number, dy: number): void {
    fish.x += dx
    fish.y += dy
    const minY = this.viewport.waterLineY + 12
    const maxY = this.viewport.waterLineY + this.viewport.maxDepth - 12
    if (fish.x < 20) fish.x = 20
    if (fish.x > this.viewport.width - 20) fish.x = this.viewport.width - 20
    if (fish.y < minY) fish.y = minY
    if (fish.y > maxY) fish.y = maxY
    fish.graphic.position.set(fish.x, fish.y)
  }

  private spawn(hungerIntensity: number): void {
    const { waterLineY, maxDepth, width } = this.viewport
    const depthBand = Math.random()
    // Hunger nudges spawns deeper (where rarer fish live)
    const biasedDepth = Math.min(1, depthBand + hungerIntensity * 0.3 * Math.random())
    const candidates = FISH_CATALOG.filter(
      (def) => biasedDepth >= def.minDepth && biasedDepth <= def.maxDepth,
    )
    const def = candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : FISH_CATALOG[0]
    const fromLeft = Math.random() < 0.5
    const x = fromLeft ? -30 : width + 30
    const y = waterLineY + 14 + biasedDepth * (maxDepth - 28)
    const fish = this.makeFish(def, x, y)
    fish.vx = (fromLeft ? 1 : -1) * (18 + Math.random() * 30)
    this.container.addChild(fish.graphic)
    this.fish.push(fish)
  }

  private makeFish(def: FishDef, x: number, y: number): AmbientFish {
    const g = new Graphics()
    const scale = 0.7 + (def.rarity === 'common' ? 0.0 : def.rarity === 'uncommon' ? 0.2 : def.rarity === 'rare' ? 0.4 : def.rarity === 'epic' ? 0.55 : 0.75)
    drawFish(g, def.color)
    g.position.set(x, y)
    g.scale.set(scale, scale)
    return { def, graphic: g, x, y, vx: 0, scale, phase: Math.random() * Math.PI * 2 }
  }
}

export function drawFish(g: Graphics, color: number): void {
  g.clear()
  // Tail
  g.poly([-10, 0, -18, -6, -18, 6])
  g.fill(color)
  // Body
  g.ellipse(0, 0, 12, 6)
  g.fill(color)
  // Belly
  g.ellipse(0, 2, 9, 3)
  g.fill({ color: 0xffffff, alpha: 0.4 })
  // Eye
  g.circle(7, -2, 1.2)
  g.fill(0xffffff)
  g.circle(7, -2, 0.6)
  g.fill(0x000000)
  // Fin
  g.poly([-2, -4, 2, -4, 0, -8])
  g.fill({ color, alpha: 0.8 })
}

export type { AmbientFish }
