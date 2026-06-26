import { Container, Graphics } from 'pixi.js'
import type { ViewportContext } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'
import { blendDepthMood, seabedY } from '../utils/depthTerrain'

interface CoralCluster {
  x: number
  baseY: number
  scale: number
  kind: 'branch' | 'fan' | 'tube'
  phase: number
}

interface KelpShadow {
  x: number
  baseY: number
  height: number
  phase: number
}

/**
 * Sloping seabed: sand rises toward the left shore and drops away to
 * the right. Solid fill to the screen bottom — no water underneath.
 */
export class SeafloorLayer {
  readonly container = new Container()

  private readonly floor = new Graphics()
  private readonly decor = new Graphics()
  private readonly kelp = new Graphics()

  private viewport: ViewportContext
  private depthMood = 0
  private scrollPx = 0
  private nightPhase = 0
  private elapsed = 0

  private corals: CoralCluster[] = []
  private kelps: KelpShadow[] = []

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.container.addChild(this.floor, this.decor, this.kelp)
    this.container.eventMode = 'none'
    this.rebuildProps()
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    this.rebuildProps()
  }

  setDepthMood(t: number): void {
    this.depthMood = Math.max(0, Math.min(1, t))
  }

  setWorldScroll(px: number): void {
    this.scrollPx = Math.max(0, px)
  }

  setTimeOfDay(snapshot: TimeOfDaySnapshot): void {
    this.nightPhase = snapshot.nightPhase
  }

  update(dtSeconds: number): void {
    this.elapsed += dtSeconds
    this.draw()
  }

  private rebuildProps(): void {
    const { width, waterLineY, maxDepth } = this.viewport
    this.corals = []
    const kinds: CoralCluster['kind'][] = ['branch', 'fan', 'tube']
    for (let i = 0; i < 16; i += 1) {
      const seed = i * 9973
      const x = ((seed * 0.013) % 1) * (width + 80) - 40
      const bed = seabedY(x, width, waterLineY, maxDepth, 0)
      this.corals.push({
        x,
        baseY: bed - 6 - ((seed * 0.021) % 1) * 14,
        scale: 0.7 + ((seed * 0.007) % 1) * 0.9,
        kind: kinds[i % kinds.length],
        phase: (seed % 628) / 100,
      })
    }
    this.kelps = []
    for (let i = 0; i < 9; i += 1) {
      const seed = i * 4523 + 11
      const x = ((seed * 0.017) % 1) * width
      const bed = seabedY(x, width, waterLineY, maxDepth, 0.5)
      this.kelps.push({
        x,
        baseY: bed - 20 - ((seed * 0.009) % 1) * 40,
        height: 60 + ((seed * 0.011) % 1) * 90,
        phase: (seed % 500) / 100,
      })
    }
  }

  private draw(): void {
    const { width, height, waterLineY, maxDepth } = this.viewport
    const mood = blendDepthMood(this.depthMood, this.scrollPx, width)
    const shallow = Math.max(0, 1 - mood / 0.55)
    const deep = Math.max(0, (mood - 0.25) / 0.75)

    const f = this.floor
    f.clear()

    if (shallow > 0.03 || deep > 0.05) {
      const segments = 48
      const sandLight = colorMix(0xf2dca8, 0x6a5840, this.nightPhase)
      const sandDark = colorMix(0xc9a050, 0x3a2818, this.nightPhase)

      // Solid sand body: sloped top edge → screen bottom.
      f.moveTo(0, height + 4)
      for (let s = 0; s <= segments; s += 1) {
        const x = (s / segments) * width
        const y = seabedY(x, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
        f.lineTo(x, y)
      }
      f.lineTo(width, height + 4)
      f.closePath()
      f.fill({ color: sandDark, alpha: shallow * 0.95 + deep * 0.25 })

      // Lighter shelf on the upper slope face.
      f.moveTo(0, seabedY(0, width, waterLineY, maxDepth, this.depthMood, this.scrollPx))
      for (let s = 0; s <= segments; s += 1) {
        const x = (s / segments) * width
        const y0 = seabedY(x, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
        const y1 = y0 + 22 * shallow + 8 * deep
        f.lineTo(x, y1)
      }
      f.lineTo(0, height + 4)
      f.closePath()
      f.fill({ color: sandLight, alpha: shallow * 0.55 })

      // Sun rays in the clear shallows (only where water is thin).
      if (shallow > 0.2) {
        for (let i = 0; i < 4; i += 1) {
          const rx = width * (0.08 + i * 0.16)
          const top = waterLineY + 12
          const bot = seabedY(rx, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
          if (bot - top < 30) continue
          f.moveTo(rx, top)
          f.lineTo(rx - 22, bot)
          f.lineTo(rx + 22, bot)
          f.closePath()
          f.fill({ color: 0xffffff, alpha: shallow * 0.035 })
        }
      }
    }

    const d = this.decor
    d.clear()
    if (shallow > 0.1) {
      const parallax = this.scrollPx * 0.3
      const wrap = width + 120
      for (const c of this.corals) {
        let cx = c.x - parallax
        cx = ((cx + wrap) % wrap) - 60
        if (cx < -50 || cx > width + 50) continue
        const bed = seabedY(cx, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
        const sway = Math.sin(this.elapsed * 0.9 + c.phase) * 2
        this.drawCoral(d, cx + sway, bed - 4, c.scale * shallow, c.kind)
      }
    }

    const k = this.kelp
    k.clear()
    if (deep > 0.15) {
      const parallax = this.scrollPx * 0.22
      const wrap = width + 80
      for (const kelp of this.kelps) {
        let x = kelp.x - parallax
        x = ((x + wrap) % wrap) - 40
        if (x < -30 || x > width + 30) continue
        const bed = seabedY(x, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
        const sway = Math.sin(this.elapsed * 0.6 + kelp.phase) * 14
        const baseY = Math.min(kelp.baseY, bed - 6)
        const top = baseY - kelp.height
        k.moveTo(x + sway, baseY)
        k.bezierCurveTo(x - 20 + sway, baseY - kelp.height * 0.4, x + 16 + sway, top + 20, x + sway, top)
        k.stroke({ color: 0x020810, width: 5, alpha: deep * 0.38 })
      }
    }
  }

  private drawCoral(
    g: Graphics,
    x: number,
    y: number,
    scale: number,
    kind: CoralCluster['kind'],
  ): void {
    const pink = colorMix(0xff7f9a, 0x5a2838, this.nightPhase)
    const orange = colorMix(0xffa85c, 0x5a3820, this.nightPhase)
    const teal = colorMix(0x4ec5b0, 0x1a4038, this.nightPhase)
    if (kind === 'branch') {
      g.roundRect(x - 3 * scale, y - 22 * scale, 6 * scale, 22 * scale, 3)
      g.fill({ color: pink, alpha: 0.85 })
      g.circle(x - 6 * scale, y - 10 * scale, 4 * scale)
      g.fill({ color: pink, alpha: 0.75 })
    } else if (kind === 'fan') {
      g.moveTo(x, y)
      g.lineTo(x - 14 * scale, y - 18 * scale)
      g.lineTo(x + 14 * scale, y - 18 * scale)
      g.closePath()
      g.fill({ color: teal, alpha: 0.7 })
    } else {
      g.roundRect(x - 4 * scale, y - 28 * scale, 8 * scale, 28 * scale, 4)
      g.fill({ color: orange, alpha: 0.75 })
    }
  }
}

function colorMix(a: number, b: number, t: number): number {
  const ti = Math.max(0, Math.min(1, t))
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  return (
    (Math.round(ar + (br - ar) * ti) << 16) |
    (Math.round(ag + (bg - ag) * ti) << 8) |
    Math.round(ab + (bb - ab) * ti)
  )
}
