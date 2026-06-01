import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'

/**
 * Drifting sea fog that sits in a horizontal band centred on the
 * waterline. Fog density picks the larger of:
 *   - storm intensity (rough seas churn up moist air)
 *   - 0.6 * nightPhase (deep night brings cold sea fog regardless)
 * plus a small beat-driven swell so the fog visibly breathes with
 * the music.
 *
 * Internally just N pre-rolled "puff" ellipses drifting LEFT with the
 * prevailing current; we redraw all of them every frame against the
 * current density so the painter is dirt cheap.
 */

interface FogPuff {
  /** World X (the painter wraps around viewport width). */
  x: number
  /** Offset from the band centre (positive = below waterline). */
  yOff: number
  /** Base radius in px. */
  r: number
  /** Per-puff "softness" multiplier so the cloud isn't uniformly fat. */
  shape: number
  /** Per-puff drift speed offset so the layer isn't a uniform shift. */
  vxJitter: number
  /** Phase for the gentle pulsing alpha. */
  phase: number
}

export class FogLayer {
  readonly container = new Container()

  private readonly puffs = new Graphics()
  private viewport: ViewportContext
  private fogPuffs: FogPuff[] = []
  private driftOffset = 0

  /** Latched weather + time-of-day snapshots. */
  private weatherIntensity = 0
  private nightPhase = 0
  /** Latched beat pulse for the density swell. */
  private beatPulse = 0

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.container.addChild(this.puffs)
    this.container.eventMode = 'none'
    this.buildPuffs()
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    this.buildPuffs()
  }

  setWeather(w: WeatherSnapshot): void {
    this.weatherIntensity = w.intensity
  }

  setTimeOfDay(t: TimeOfDaySnapshot): void {
    this.nightPhase = t.nightPhase
  }

  setBeatPulse(p: number): void {
    this.beatPulse = p
  }

  update(dtSeconds: number): void {
    // Density: max of storm + night, plus a small beat swell on top.
    const baseDensity = Math.max(this.weatherIntensity, this.nightPhase * 0.6)
    const density = Math.min(1, baseDensity + this.beatPulse * 0.04)
    // Bail out early when there's basically no fog — keeps a sunny
    // noonday scene from paying for ~150 ellipse draws every frame.
    if (density < 0.04) {
      this.puffs.clear()
      return
    }
    // Drift LEFT with the current — speed scales with storm so squalls
    // visibly rip fog past the boat.
    const driftSpeed = 14 + this.weatherIntensity * 28
    this.driftOffset = (this.driftOffset + driftSpeed * dtSeconds) % 4000
    this.drawPuffs(density)
  }

  private buildPuffs(): void {
    const { width } = this.viewport
    this.fogPuffs = []
    // Spread puffs across 2× the viewport width so the wrap is seamless.
    const span = Math.max(800, width * 2)
    // Fewer, smaller puffs — earlier sizing (30..100 px radius) read as
    // big cottony clouds glued to the water; we want a low atmospheric
    // haze that softens the horizon line, not opaque blobs.
    const count = 48
    for (let i = 0; i < count; i += 1) {
      this.fogPuffs.push({
        x: Math.random() * span,
        // Slimmer vertical band (~36 px) hugging the waterline.
        yOff: (Math.random() - 0.5) * 36 + 6,
        r: 10 + Math.random() * 18,
        shape: 0.7 + Math.random() * 0.6,
        vxJitter: (Math.random() - 0.5) * 8,
        phase: Math.random() * Math.PI * 2,
      })
    }
  }

  private drawPuffs(density: number): void {
    const { width, waterLineY } = this.viewport
    const g = this.puffs
    g.clear()
    // Colour: warm cream-grey during the day → cool silver-blue at night.
    const dayColor = 0xeef0e8
    const nightColor = 0x9eb3cc
    const color = colorMix(dayColor, nightColor, this.nightPhase)
    // Alpha scales with density; capped to keep the scene readable.
    // Cut roughly in half versus the original (0.35) — smaller puffs
    // need lower individual alpha to read as atmospheric haze instead
    // of opaque cotton.
    const baseAlpha = 0.2 * density
    // Band centred on waterline. We pre-roll the y per puff but anchor
    // it relative to the live waterline so resizes still look right.
    const bandY = waterLineY
    const span = Math.max(800, width * 2)
    // Time-pulse for breathing alpha; uses Date.now so it survives the
    // life of the entity (rather than an instance accumulator).
    const tPulse = (Date.now() % 100000) / 1000
    for (const p of this.fogPuffs) {
      // World X with wrap.
      const wx = ((p.x - this.driftOffset - p.vxJitter * tPulse) % span + span) % span - 200
      if (wx > width + 200 || wx < -200) continue
      const py = bandY + p.yOff
      const alpha = baseAlpha * (0.55 + 0.45 * Math.sin(tPulse * 0.4 + p.phase))
      // Single low ellipse — flat oval shape so the layer reads as a
      // horizontal mist band rather than a stack of cumulus blobs.
      g.ellipse(wx, py, p.r * p.shape, p.r * 0.28)
      g.fill({ color, alpha })
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
  const r = Math.round(ar + (br - ar) * ti)
  const g = Math.round(ag + (bg - ag) * ti)
  const bch = Math.round(ab + (bb - ab) * ti)
  return (r << 16) | (g << 8) | bch
}
