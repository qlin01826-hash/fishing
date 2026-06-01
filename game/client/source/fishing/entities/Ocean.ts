import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'

/**
 * Sky + sea + underwater background.
 *
 * - Sky gradient driven by weather (calm = blue, storm = bruise-purple)
 * - Multiple wave "ribbons" scroll left to simulate forward motion
 * - Lightning flashes overlay when weather is `storm`
 * - Rain streaks scale with weather intensity
 *
 * All drawing is deterministic per-frame so layout changes (resize)
 * simply rebuild the graphics — no off-screen buffering trickery.
 */
export class Ocean {
  /**
   * Background painters (sky gradient + underwater gradient). Mounted
   * by FishingScene BEHIND any decoration layers (horizon / clouds /
   * birds) so those decorations have something to sit on top of.
   */
  readonly backLayer = new Container()
  /**
   * Foreground painters (depth bands + wave ribbons + rain + lightning
   * flash). Mounted by FishingScene IN FRONT of the decoration layers
   * so distant mountains tuck behind the actual wave crests, the way a
   * real horizon does when you look out across water.
   */
  readonly frontLayer = new Container()
  /**
   * Compatibility shim: anywhere we used to mount `ocean.container`
   * we still want a single grouping. New code should prefer the
   * explicit back/front layers above.
   */
  readonly container = new Container()

  private readonly sky = new Graphics()
  private readonly underwater = new Graphics()
  private readonly farWaves = new Graphics()
  private readonly nearWaves = new Graphics()
  private readonly rain = new Graphics()
  private readonly flash = new Graphics()
  private readonly depthBands = new Graphics()

  private waveOffset = 0
  private rainOffset = 0
  private flashTimer = 0
  private timeSinceLastBolt = 0
  private viewport: ViewportContext

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.backLayer.addChild(this.sky, this.underwater)
    this.frontLayer.addChild(this.depthBands, this.farWaves, this.nearWaves, this.rain, this.flash)
    // The legacy `container` keeps both groups together for any caller
    // that still wants one drop-in node.
    this.container.addChild(this.backLayer, this.frontLayer)
    this.flash.alpha = 0
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
  }

  update(
    dtSeconds: number,
    weather: WeatherSnapshot,
    elapsedMs: number,
    beatPulse = 0,
    timeOfDay?: TimeOfDaySnapshot,
  ): void {
    // Waves drift left at a baseline current plus wind push
    const driftSpeed = 40 + weather.windPush * 0.8
    this.waveOffset = (this.waveOffset + driftSpeed * dtSeconds) % 200
    this.rainOffset = (this.rainOffset + 600 * dtSeconds) % 60

    // nightPhase: 0 noon → 1 midnight. Defaults to "day" if no time
    // system is wired, so this entity still works in isolation tests.
    const nightPhase = timeOfDay?.nightPhase ?? 0
    // sunsetGlow: sharp pulse around dusk/dawn (sunAltitude ~ 0.0..0.35).
    // Used to bleed warm orange/pink into the sky strips along the
    // horizon when the sun is just kissing the waterline.
    const sunAlt = timeOfDay?.sunAltitude ?? 1
    const sunsetGlow =
      sunAlt > 0 && sunAlt < 0.35 ? 1 - Math.abs(sunAlt - 0.12) / 0.23 : 0

    this.drawSky(weather, nightPhase, Math.max(0, Math.min(1, sunsetGlow)))
    this.drawUnderwater(nightPhase)
    this.drawDepthBands()
    this.drawWaves(weather, elapsedMs, beatPulse, nightPhase)
    this.drawRain(weather)
    this.tickLightning(dtSeconds, weather)
  }

  private drawSky(weather: WeatherSnapshot, nightPhase: number, sunsetGlow: number): void {
    const { width, waterLineY } = this.viewport
    const g = this.sky
    g.clear()

    // Bake a quick "gradient" with N horizontal strips. 24 strips is
    // visually smooth enough without dominating draw time.
    const strips = 24
    // Daytime palette (used when nightPhase=0): the previous calm-sky
    // mix that storm weather can shift toward bruise-purple.
    const dayTop = colorMix(0xa9dcff, 0x3a2c5b, weather.intensity)
    const dayBot = colorMix(0x8dc7ff, 0x6d4e91, weather.intensity)
    // Nighttime palette: deep navy ceiling that washes into indigo at
    // the horizon. Weather has a much smaller effect at night because
    // it's already dark.
    const nightTop = colorMix(0x05082b, 0x0a0a1c, weather.intensity * 0.5)
    const nightBot = colorMix(0x1d2860, 0x171a3a, weather.intensity * 0.5)
    const top = colorMix(dayTop, nightTop, nightPhase)
    const bot = colorMix(dayBot, nightBot, nightPhase)
    // Sunset/sunrise warm wash: lerp the LOWER strips toward warm
    // orange. Strongest right at the horizon, fading out by the top.
    const glowColor = colorMix(0xff8d4a, 0x6b1d5f, nightPhase * 0.4)
    for (let i = 0; i < strips; i += 1) {
      const t = i / (strips - 1)
      let color = colorMix(top, bot, t)
      if (sunsetGlow > 0) {
        // Weight glow heavily near the horizon (t close to 1).
        const glowMix = sunsetGlow * Math.pow(t, 1.4) * 0.7
        color = colorMix(color, glowColor, glowMix)
      }
      g.rect(0, (waterLineY * i) / strips, width, waterLineY / strips + 1)
      g.fill(color)
    }
  }

  private drawUnderwater(nightPhase: number): void {
    const { width, height, waterLineY } = this.viewport
    const g = this.underwater
    g.clear()
    const strips = 18
    // Even underwater dims at night — the surface lets in less light.
    const top = colorMix(0x2f78a9, 0x0c1c3d, nightPhase)
    const bot = colorMix(0x051628, 0x010512, nightPhase)
    for (let i = 0; i < strips; i += 1) {
      const t = i / (strips - 1)
      const color = colorMix(top, bot, t)
      const stripH = (height - waterLineY) / strips + 1
      g.rect(0, waterLineY + (i * (height - waterLineY)) / strips, width, stripH)
      g.fill(color)
    }
  }

  private drawDepthBands(): void {
    const { width, waterLineY, maxDepth } = this.viewport
    const g = this.depthBands
    g.clear()
    // Subtle horizontal lines suggest depth strata where fish live
    const bands = 4
    for (let i = 1; i <= bands; i += 1) {
      const y = waterLineY + (maxDepth * i) / (bands + 1)
      g.rect(0, y, width, 1)
      g.fill({ color: 0xffffff, alpha: 0.04 })
    }
  }

  private drawWaves(
    weather: WeatherSnapshot,
    elapsedMs: number,
    beatPulse: number,
    nightPhase: number,
  ): void {
    const { width, waterLineY } = this.viewport
    // Beat-synced amplitude bump — the sea breathes with the soundtrack.
    const amplitude = (3 + weather.intensity * 14) * (1 + beatPulse * 0.45)
    const time = elapsedMs * 0.001
    // Waves shift toward deep cobalt/navy at night so the surface
    // reads as moonlit black water rather than washed-out daylight.
    const farDay = colorMix(0xeaf6ff, 0xb0a3d3, weather.intensity)
    const nearDay = colorMix(0xc4e3ff, 0x7a6aa5, weather.intensity)
    const farNight = colorMix(0x4a608a, 0x2c2750, weather.intensity)
    const nearNight = colorMix(0x2e4070, 0x1a1735, weather.intensity)
    const farColor = colorMix(farDay, farNight, nightPhase)
    const nearColor = colorMix(nearDay, nearNight, nightPhase)
    this.farWaves.clear()
    this.nearWaves.clear()

    const segments = 64
    for (let pass = 0; pass < 2; pass += 1) {
      const g = pass === 0 ? this.farWaves : this.nearWaves
      const color = pass === 0 ? farColor : nearColor
      const yBase = waterLineY + (pass === 0 ? -2 : 4)
      const offset = pass === 0 ? this.waveOffset * 0.6 : this.waveOffset
      const ampMul = pass === 0 ? 0.45 : 1
      g.moveTo(-20, yBase + 40)
      for (let s = 0; s <= segments; s += 1) {
        const x = (s / segments) * (width + 40) - 20
        const phase = (x + offset) * 0.018 + time * (pass === 0 ? 1.2 : 1.7)
        const y = yBase + Math.sin(phase) * amplitude * ampMul + Math.sin(phase * 2.3 + 1.7) * amplitude * 0.35 * ampMul
        g.lineTo(x, y)
      }
      g.lineTo(width + 20, yBase + 80)
      g.lineTo(-20, yBase + 80)
      g.closePath()
      g.fill({ color, alpha: pass === 0 ? 0.6 : 0.9 })
    }
  }

  private drawRain(weather: WeatherSnapshot): void {
    const g = this.rain
    g.clear()
    if (weather.intensity < 0.35) return
    const { width, waterLineY } = this.viewport
    const density = Math.floor(60 + weather.intensity * 220)
    const lineLen = 12 + weather.intensity * 14
    const skewX = -2 - weather.intensity * 4
    // Rain is deterministic per offset; we use a hashed pseudo-random per drop
    for (let i = 0; i < density; i += 1) {
      const seed = i * 7919
      const baseX = ((seed * 13.37 + this.rainOffset * 0.7) % (width + 40)) - 20
      const baseY = ((seed * 23.71 + this.rainOffset * 4) % (waterLineY + 40)) - 20
      g.moveTo(baseX, baseY)
      g.lineTo(baseX + skewX, baseY + lineLen)
    }
    g.stroke({ color: 0xeaf3ff, alpha: 0.35 + weather.intensity * 0.35, width: 1 })
  }

  private tickLightning(dtSeconds: number, weather: WeatherSnapshot): void {
    const { width, height } = this.viewport
    if (this.flashTimer > 0) {
      this.flashTimer -= dtSeconds
      const a = Math.max(0, this.flashTimer / 0.25)
      this.flash.clear()
      this.flash.rect(0, 0, width, height)
      this.flash.fill({ color: 0xffffff, alpha: a * 0.55 })
    } else if (this.flash.alpha > 0) {
      this.flash.clear()
    }
    if (weather.tier !== 'storm') {
      this.timeSinceLastBolt = 0
      return
    }
    this.timeSinceLastBolt += dtSeconds
    if (this.timeSinceLastBolt > 4 && Math.random() < dtSeconds * 0.4) {
      this.flashTimer = 0.25
      this.timeSinceLastBolt = 0
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
