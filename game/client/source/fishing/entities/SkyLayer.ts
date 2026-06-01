import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'

/**
 * Decorative sky props that sit ABOVE the ocean gradient but BEHIND the
 * boat/hook/UI. Drives the "we're sailing somewhere" feeling so the
 * player doesn't see a static backdrop for the whole run.
 *
 * Layers (back → front, all drawn in this class):
 *   - The sun/moon disc, parked top-right with a soft glow.
 *   - Slow-scrolling cloud silhouettes at two parallax speeds.
 *   - Occasional seagull flocks (V-formation) that cross the screen.
 *
 * Update flow: `update(dt, weather)` advances everything; weather is
 * used only for opacity dampening (clouds dim in storm, birds vanish).
 */
export class SkyLayer {
  readonly container = new Container()

  private readonly stars = new Graphics()
  /** Aurora ribbon — drawn between stars and moon. */
  private readonly aurora = new Graphics()
  /** Shooting-star streaks live here so they don't get muddled with the
   *  steady star painter (which clears every frame). */
  private readonly shootingStars = new Graphics()
  private readonly moon = new Graphics()
  private readonly sun = new Graphics()
  private readonly farClouds = new Graphics()
  private readonly nearClouds = new Graphics()
  private readonly birds = new Graphics()

  private viewport: ViewportContext
  private farOffset = 0
  private nearOffset = 0

  /** Cloud silhouettes — generated once, repositioned via offset each frame. */
  private cloudShapes: Array<{
    layer: 0 | 1
    x: number
    y: number
    scale: number
    blobs: Array<[number, number, number]>
  }> = []

  /**
   * Pre-baked star field. Coordinates are NORMALISED (0..1) so a viewport
   * resize doesn't reshuffle the constellation — we just multiply by the
   * current width/height when drawing.
   */
  private starField: Array<{ x: number; y: number; r: number; twinkle: number }> = []

  /** Live seagull flocks. */
  private flocks: Array<{
    x: number
    y: number
    speed: number // px/s, positive moves right
    /** Number of birds in V. */
    n: number
    /** Per-bird wing phase. */
    wingPhase: number
  }> = []
  private timeSinceFlock = 0
  /** Next interval at which we'll try to spawn a new flock (seconds). */
  private nextFlockEverySec = 8

  /** Aurora phase clock (drives the wavy curtain animation). */
  private auroraPhase = 0
  /** Active shooting-star streaks. */
  private streaks: Array<{
    x: number
    y: number
    vx: number
    vy: number
    /** 1→0 lifetime. */
    t: number
    /** Tail length proportional to speed; cached so renders are stable. */
    tailLen: number
  }> = []
  private timeSinceStreak = 0
  private nextStreakIn = 6
  /** Cached beat pulse for downbeat-edge detection. */
  private prevBeatPulse = 0

  /** Latest time-of-day snapshot (defaults to "high noon"). */
  private tod: TimeOfDaySnapshot = {
    nightPhase: 0,
    sunAltitude: 1,
    moonAltitude: 0,
    sunArcX: 0.78,
    moonArcX: 0.22,
    starOpacity: 0,
    period: 'day',
  }

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    // Z order (back to front): stars → aurora → shooting stars → moon
    // → sun → clouds → birds. Aurora lives between the static star
    // field and the moon so it visibly washes across the constellation
    // while still passing in front of distant horizon haze.
    this.container.addChild(
      this.stars,
      this.aurora,
      this.shootingStars,
      this.moon,
      this.sun,
      this.farClouds,
      this.nearClouds,
      this.birds,
    )
    this.container.eventMode = 'none'
    this.buildClouds()
    this.buildStars()
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    this.buildClouds()
    // Star field is normalised so we don't rebuild on resize.
  }

  /**
   * Latch the latest time-of-day snapshot. SkyLayer reads it each
   * frame in `update` to position the sun/moon and modulate cloud and
   * bird opacity.
   */
  setTimeOfDay(snapshot: TimeOfDaySnapshot): void {
    this.tod = snapshot
  }

  update(dtSeconds: number, weather: WeatherSnapshot, elapsedMs: number, beatPulse = 0): void {
    // Cloud parallax — far ribbon drifts slowly, near ribbon faster.
    // Storm weather dampens drift visually (everything looks heavier).
    const speedMul = 1 - weather.intensity * 0.4
    this.farOffset = (this.farOffset + 6 * dtSeconds * speedMul) % 2000
    this.nearOffset = (this.nearOffset + 14 * dtSeconds * speedMul) % 2000

    // Aurora phase ticks at a slow base rate plus extra push on each
    // downbeat so the curtains visibly ripple in time with the music.
    this.auroraPhase += dtSeconds * (0.6 + beatPulse * 1.8)

    // Shooting stars: only spawn during deep night, and slightly more
    // likely on a downbeat (so the music "wishes" stars across the sky).
    this.updateShootingStars(dtSeconds, beatPulse)

    this.drawStars(elapsedMs)
    this.drawAurora(beatPulse)
    this.drawShootingStars()
    this.drawMoon()
    this.drawSun(weather, elapsedMs)
    this.drawClouds(weather)
    this.updateBirds(dtSeconds, weather)

    this.prevBeatPulse = beatPulse
  }

  // ---- Sun / moon discs + starfield ----

  private drawSun(weather: WeatherSnapshot, elapsedMs: number): void {
    const { width, waterLineY } = this.viewport
    const g = this.sun
    g.clear()
    // Below the horizon → don't render at all.
    if (this.tod.sunAltitude < 0.005) return
    // Arc across the sky: horizontal position cycles east → west, and
    // height = (1 - altitude) so altitude=1 puts the disc near the top.
    const cx = width * (0.08 + this.tod.sunArcX * 0.84)
    // Allow the disc to dip BELOW the waterline a bit so sunset feels
    // like the sun actually sinks into the sea.
    const ceiling = waterLineY * 0.12
    const floor = waterLineY - 16
    const cy = floor - (floor - ceiling) * this.tod.sunAltitude
    // Storm dims the sun. At dusk we keep it visible — the colour shift
    // does the "low sun" work below.
    const stormDim = Math.max(0.15, 1 - weather.intensity * 0.85)
    const baseAlpha = stormDim * (0.4 + 0.6 * Math.min(1, this.tod.sunAltitude * 2.5))
    // Colour: white-yellow at zenith, deep orange/red as the disc nears
    // the horizon. Same trick most painted skies use.
    const sunCore = colorMix(0xff8a3c, 0xfff4c2, Math.min(1, this.tod.sunAltitude * 2))
    const sunHalo = colorMix(0xff5a44, 0xffe8a8, Math.min(1, this.tod.sunAltitude * 2))
    // Soft halo: stacked discs of decreasing alpha.
    const haloLayers: Array<[number, number]> = [
      [60, 0.07 * baseAlpha],
      [42, 0.13 * baseAlpha],
      [28, 0.22 * baseAlpha],
    ]
    for (const [r, a] of haloLayers) {
      g.circle(cx, cy, r)
      g.fill({ color: sunHalo, alpha: a })
    }
    // Slow "breath" pulse so the disc isn't dead-still.
    const breath = 1 + Math.sin(elapsedMs * 0.0008) * 0.04
    g.circle(cx, cy, 18 * breath)
    g.fill({ color: sunCore, alpha: baseAlpha })
  }

  private drawMoon(): void {
    const { width, waterLineY } = this.viewport
    const g = this.moon
    g.clear()
    if (this.tod.moonAltitude < 0.005) return
    const cx = width * (0.08 + this.tod.moonArcX * 0.84)
    const ceiling = waterLineY * 0.12
    const floor = waterLineY - 16
    const cy = floor - (floor - ceiling) * this.tod.moonAltitude
    const alpha = 0.45 + 0.5 * Math.min(1, this.tod.moonAltitude * 2.5)
    // Halo
    g.circle(cx, cy, 36)
    g.fill({ color: 0xc9d4ff, alpha: 0.05 * alpha })
    g.circle(cx, cy, 24)
    g.fill({ color: 0xeef3ff, alpha: 0.1 * alpha })
    // Body — soft ivory disc.
    g.circle(cx, cy, 14)
    g.fill({ color: 0xfaf6e1, alpha: alpha })
    // Crater spots for character — three darker patches.
    const craters: Array<[number, number, number]> = [
      [-4, -3, 2.5],
      [3, 2, 1.6],
      [-2, 5, 1.2],
    ]
    for (const [dx, dy, r] of craters) {
      g.circle(cx + dx, cy + dy, r)
      g.fill({ color: 0xd6cfb1, alpha: alpha * 0.55 })
    }
  }

  private drawStars(elapsedMs: number): void {
    const g = this.stars
    g.clear()
    if (this.tod.starOpacity < 0.02) return
    const { width, waterLineY } = this.viewport
    const baseAlpha = this.tod.starOpacity
    const tSec = elapsedMs * 0.001
    for (const s of this.starField) {
      // Twinkle: gentle sine modulation keyed off the per-star phase
      // so neighbours don't twinkle in lockstep.
      const twink = 0.7 + 0.3 * Math.sin(tSec * 2.3 + s.twinkle)
      const a = baseAlpha * twink
      const px = s.x * width
      const py = s.y * waterLineY * 0.85 // keep stars above the horizon
      g.circle(px, py, s.r)
      g.fill({ color: 0xffffff, alpha: a })
      // Brighter stars get a tiny 4-point glint.
      if (s.r > 1.4) {
        g.moveTo(px - s.r * 2.4, py)
        g.lineTo(px + s.r * 2.4, py)
        g.moveTo(px, py - s.r * 2.4)
        g.lineTo(px, py + s.r * 2.4)
        g.stroke({ color: 0xffffff, alpha: a * 0.6, width: 0.6 })
      }
    }
  }

  // ---- Aurora ----

  /**
   * Wavy "northern lights" ribbon high in the night sky. Composed of
   * three vertically-offset color bands (green base → cyan mid →
   * violet tip) that each undulate via a low-frequency sin. Visibility
   * ramps up with nightPhase and the curtains pulse on each beat.
   */
  private drawAurora(beatPulse: number): void {
    const g = this.aurora
    g.clear()
    // Only visible deep into night; ramp starts around evening.
    const visibility = Math.max(0, (this.tod.nightPhase - 0.55) / 0.45)
    if (visibility < 0.02) return
    const { width, waterLineY } = this.viewport
    // Anchor the ribbon to the upper third of the sky.
    const bandTop = waterLineY * 0.12
    const bandBottom = waterLineY * 0.42
    const segments = 48
    // Beat lifts the curtain — peaks brighten and the wave amplitude
    // jumps on a downbeat so the ribbon visibly "breathes".
    const beatBoost = 1 + beatPulse * 0.55
    // Three colour bands, drawn back-to-front.
    const bands: Array<{ color: number; alpha: number; yOff: number; ampMul: number }> = [
      { color: 0x3aff8a, alpha: 0.16, yOff: 0, ampMul: 1.0 }, // green base
      { color: 0x5aeaff, alpha: 0.14, yOff: -14, ampMul: 0.78 }, // cyan mid
      { color: 0xa66bff, alpha: 0.12, yOff: -30, ampMul: 0.55 }, // violet tip
    ]
    for (const b of bands) {
      g.moveTo(-20, bandBottom)
      for (let i = 0; i <= segments; i += 1) {
        const x = (i / segments) * (width + 40) - 20
        // Two layered sinusoids give the iconic "curtain folding" look.
        const wave =
          Math.sin(this.auroraPhase * 1.2 + x * 0.012) * 16 +
          Math.sin(this.auroraPhase * 0.45 + x * 0.003) * 10
        const y = bandTop + (bandBottom - bandTop) * 0.4 + wave * b.ampMul + b.yOff
        g.lineTo(x, y)
      }
      g.lineTo(width + 20, bandBottom)
      g.closePath()
      g.fill({ color: b.color, alpha: b.alpha * visibility * beatBoost })
    }
    // Optional bright top "edge" highlight that pulses with the beat.
    if (beatPulse > 0.2) {
      const edgeAlpha = 0.18 * visibility * beatPulse
      g.moveTo(-20, bandTop + 12)
      for (let i = 0; i <= segments; i += 1) {
        const x = (i / segments) * (width + 40) - 20
        const wave =
          Math.sin(this.auroraPhase * 1.2 + x * 0.012) * 16 * 0.55 +
          Math.sin(this.auroraPhase * 0.45 + x * 0.003) * 10 * 0.55
        const y = bandTop + 12 + wave + -30
        g.lineTo(x, y)
      }
      g.stroke({ color: 0xeaffff, alpha: edgeAlpha, width: 1.4 })
    }
  }

  // ---- Shooting stars ----

  private updateShootingStars(dtSeconds: number, beatPulse: number): void {
    // Only at night.
    const nightActive = this.tod.starOpacity > 0.4
    this.timeSinceStreak += dtSeconds
    if (nightActive && this.timeSinceStreak > this.nextStreakIn) {
      this.timeSinceStreak = 0
      // Bias the interval shorter when we land on a downbeat.
      const beatBias = beatPulse > 0.5 && this.prevBeatPulse < 0.4 ? 0.5 : 1
      this.nextStreakIn = (4 + Math.random() * 10) * beatBias
      this.spawnShootingStar()
    }
    for (const s of this.streaks) {
      s.x += s.vx * dtSeconds
      s.y += s.vy * dtSeconds
      s.t -= dtSeconds * 1.4
    }
    this.streaks = this.streaks.filter(
      (s) => s.t > 0 && s.x > -200 && s.x < this.viewport.width + 200,
    )
  }

  private spawnShootingStar(): void {
    const { width, waterLineY } = this.viewport
    // Spawn in the upper third of the sky, streaking diagonally down.
    const fromLeft = Math.random() < 0.55
    const startX = fromLeft ? Math.random() * width * 0.3 : width * 0.7 + Math.random() * width * 0.3
    const startY = Math.random() * waterLineY * 0.35 + waterLineY * 0.05
    // Speed: fast.
    const dirX = fromLeft ? 1 : -1
    const speed = 380 + Math.random() * 220
    const angle = (Math.PI / 6) * (0.6 + Math.random() * 0.6) // 18°–42° downward
    const vx = Math.cos(angle) * speed * dirX
    const vy = Math.sin(angle) * speed
    this.streaks.push({
      x: startX,
      y: startY,
      vx,
      vy,
      t: 1,
      tailLen: 40 + Math.random() * 30,
    })
  }

  private drawShootingStars(): void {
    const g = this.shootingStars
    g.clear()
    if (this.streaks.length === 0) return
    for (const s of this.streaks) {
      const a = Math.min(1, s.t) * this.tod.starOpacity
      // Tail: a stretched line opposite the velocity direction.
      const mag = Math.hypot(s.vx, s.vy) || 1
      const tx = s.x - (s.vx / mag) * s.tailLen
      const ty = s.y - (s.vy / mag) * s.tailLen
      g.moveTo(s.x, s.y)
      g.lineTo(tx, ty)
      g.stroke({ color: 0xfff8d4, width: 2, alpha: a })
      // Bright head.
      g.circle(s.x, s.y, 1.8)
      g.fill({ color: 0xffffff, alpha: a })
      // Soft halo around head.
      g.circle(s.x, s.y, 4)
      g.fill({ color: 0xfff8d4, alpha: a * 0.25 })
    }
  }

  private buildStars(): void {
    this.starField = []
    const count = 70
    for (let i = 0; i < count; i += 1) {
      this.starField.push({
        x: Math.random(),
        y: Math.random() * 0.7, // bias to the upper portion of the sky
        r: 0.7 + Math.random() * 1.6,
        twinkle: Math.random() * Math.PI * 2,
      })
    }
  }

  // ---- Clouds ----

  private buildClouds(): void {
    const { width, waterLineY } = this.viewport
    this.cloudShapes = []
    // Two parallax layers, each with ~6 silhouette clouds spaced
    // across a 2× viewport width window (so they tile cleanly via the
    // running offset).
    for (let layer = 0; layer < 2; layer += 1) {
      const lane = layer === 0 ? waterLineY * 0.15 : waterLineY * 0.32
      const count = 6
      for (let i = 0; i < count; i += 1) {
        const x = (i / count) * width * 2
        const y = lane + (Math.random() - 0.5) * 14
        const scale = layer === 0 ? 0.7 + Math.random() * 0.4 : 1 + Math.random() * 0.6
        const blobs = makeCloudBlobs()
        this.cloudShapes.push({ layer: layer as 0 | 1, x, y, scale, blobs })
      }
    }
  }

  private drawClouds(weather: WeatherSnapshot): void {
    const { width } = this.viewport
    // Storm darkens the clouds (and increases alpha so they read as a
    // heavy overcast layer). Night-time pushes them even further toward
    // a low-saturation deep blue so they read as silhouettes against
    // the moonlit sky.
    const t = weather.intensity
    const stormColor = colorMix(0xffffff, 0x394560, t)
    const nightColor = colorMix(0x4a527a, 0x16182f, t)
    const cloudColor = colorMix(stormColor, nightColor, this.tod.nightPhase)
    const baseAlpha = 0.72 + t * 0.18 - this.tod.nightPhase * 0.15
    const winSpan = width * 2
    for (let pass = 0; pass < 2; pass += 1) {
      const g = pass === 0 ? this.farClouds : this.nearClouds
      g.clear()
      const off = pass === 0 ? this.farOffset : this.nearOffset
      const alpha = baseAlpha * (pass === 0 ? 0.75 : 1)
      for (const c of this.cloudShapes) {
        if (c.layer !== pass) continue
        // Wrap into the visible window [-200, width+200] by modulo.
        const drift = ((c.x - off) % winSpan + winSpan) % winSpan - 200
        if (drift > width + 200 || drift < -200) continue
        for (const [bx, by, br] of c.blobs) {
          g.ellipse(drift + bx * c.scale, c.y + by * c.scale, br * c.scale, br * c.scale * 0.7)
          g.fill({ color: cloudColor, alpha })
        }
      }
    }
  }

  // ---- Seagull flocks ----

  private updateBirds(dtSeconds: number, weather: WeatherSnapshot): void {
    // No birds in heavy weather — they all flew home. Also no birds
    // after dusk; seagulls roost at night.
    const allowSpawn = weather.intensity < 0.65 && this.tod.sunAltitude > 0.15
    this.timeSinceFlock += dtSeconds
    if (allowSpawn && this.timeSinceFlock > this.nextFlockEverySec) {
      this.timeSinceFlock = 0
      this.nextFlockEverySec = 10 + Math.random() * 14
      const fromLeft = Math.random() < 0.55
      const speed = (fromLeft ? 1 : -1) * (40 + Math.random() * 35)
      this.flocks.push({
        x: fromLeft ? -120 : this.viewport.width + 120,
        y: this.viewport.waterLineY * (0.18 + Math.random() * 0.25),
        speed,
        n: 4 + Math.floor(Math.random() * 4),
        wingPhase: Math.random() * Math.PI * 2,
      })
    }

    for (const f of this.flocks) {
      f.x += f.speed * dtSeconds
      f.wingPhase += dtSeconds * 6.5
    }
    const wd = this.viewport.width
    this.flocks = this.flocks.filter((f) => f.x > -200 && f.x < wd + 200)

    const g = this.birds
    g.clear()
    const baseAlpha = Math.max(0.05, 1 - weather.intensity * 1.15)
    for (const f of this.flocks) {
      const dir = f.speed >= 0 ? 1 : -1
      const wingY = Math.sin(f.wingPhase) * 1.6
      // V-formation: leader at front, others fan out behind.
      for (let i = 0; i < f.n; i += 1) {
        const back = i // 0 = leader
        const offX = -back * 14 * dir
        const offY = back * 7 - wingY * 0.5
        drawSeagull(g, f.x + offX, f.y + offY, dir, wingY, baseAlpha)
      }
    }
  }
}

// ----- helpers -----

/** Generate a fluffy multi-blob cloud silhouette around the local origin. */
function makeCloudBlobs(): Array<[number, number, number]> {
  const blobs: Array<[number, number, number]> = []
  const n = 4 + Math.floor(Math.random() * 3)
  const cx = 0
  const cy = 0
  for (let i = 0; i < n; i += 1) {
    const t = (i - (n - 1) / 2) / n
    const x = cx + t * 60 + (Math.random() - 0.5) * 18
    const y = cy + (Math.random() - 0.5) * 6
    const r = 14 + Math.random() * 12
    blobs.push([x, y, r])
  }
  // One puff on top.
  blobs.push([cx + (Math.random() - 0.5) * 18, cy - 10, 14 + Math.random() * 6])
  return blobs
}

function drawSeagull(
  g: Graphics,
  x: number,
  y: number,
  dir: 1 | -1,
  wingTilt: number,
  baseAlpha: number,
): void {
  // A simple stylised "M" shape — two angled wings.
  // wingTilt > 0 → wings raised. wingTilt < 0 → wings lowered.
  const span = 14
  const dropY = -wingTilt * 1.4
  const a = baseAlpha
  g.moveTo(x - span * dir, y - dropY)
  g.lineTo(x - span * 0.4 * dir, y + dropY * 0.5)
  g.lineTo(x, y - dropY * 0.3)
  g.lineTo(x + span * 0.4 * dir, y + dropY * 0.5)
  g.lineTo(x + span * dir, y - dropY)
  g.stroke({ color: 0x16223a, width: 2, alpha: a })
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
