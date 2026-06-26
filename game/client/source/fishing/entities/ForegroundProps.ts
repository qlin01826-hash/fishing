import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'

/**
 * Close-camera flotsam that drifts past the boat to sell forward
 * motion: jagged reefs, navigation buoys, driftwood logs. Sits ABOVE
 * the wave layer (so the reef base "interrupts" the waterline cleanly
 * with foam) and BEHIND the boat / penguin (so the boat passes in
 * front of anything it overlaps).
 *
 * Distinct from HorizonLayer:
 *   - HorizonLayer = distant mountains / islands / lighthouses on the
 *     horizon, parallax slow, small silhouettes.
 *   - ForegroundProps = near-camera objects at the waterline, parallax
 *     fast, full-detail.
 *
 * Spawn cadence is irregular (Poisson-ish) so the player rarely sees
 * empty water for long but never gets a steady rhythm of identical
 * props either.
 */
export class ForegroundProps {
  readonly container = new Container()

  private readonly graphics = new Graphics()

  private viewport: ViewportContext
  private nightPhase = 0
  private moonAltitude = 0
  private worldScroll = 0

  /** Wall-clock seconds — used for buoy bob phase + buoy beacon blink. */
  private elapsed = 0
  /** Latest beat pulse for beacon flicker. */
  private beatPulse = 0

  private props: Prop[] = []
  private timeSinceSpawn = 0
  private nextSpawnIn = 5

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.container.addChild(this.graphics)
    this.container.eventMode = 'none'
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
  }

  setTimeOfDay(snapshot: TimeOfDaySnapshot): void {
    this.nightPhase = snapshot.nightPhase
    this.moonAltitude = snapshot.moonAltitude
  }

  setBeatPulse(pulse: number): void {
    this.beatPulse = pulse
  }

  setWorldScroll(px: number): void {
    this.worldScroll = Math.max(0, px)
  }

  update(dtSeconds: number, weather: WeatherSnapshot, sailMul = 1): void {
    this.elapsed += dtSeconds

    // Spawn cadence: average ~9 s between props with a wind-driven
    // boost so storm runs feel busier as the boat plows ahead.
    this.timeSinceSpawn += dtSeconds
    if (this.timeSinceSpawn >= this.nextSpawnIn) {
      this.timeSinceSpawn = 0
      this.nextSpawnIn = 5 + Math.random() * 8 - weather.windPush * 0.01
      this.spawnRandom()
    }

    const baseSpeed = (38 + weather.windPush * 0.14) * sailMul
    const scrollSpeed = baseSpeed * 1.35 + this.worldScroll * 0.002

    for (const p of this.props) {
      p.x -= scrollSpeed * p.speedMul * dtSeconds
      // Driftwood drifts with a tiny rotation jitter — sells the float.
      if (p.kind === 'driftwood') {
        p.rotation += Math.sin(this.elapsed * 0.6 + p.phase) * dtSeconds * 0.18
      }
    }
    // Cull props once they're well off the LEFT edge.
    this.props = this.props.filter((p) => p.x > -160)

    this.draw(weather)
  }

  private spawnRandom(): void {
    const roll = Math.random()
    let kind: Prop['kind']
    // 45% reef (the headline prop), 35% buoy, 20% driftwood.
    if (roll < 0.45) kind = 'reef'
    else if (roll < 0.8) kind = 'buoy'
    else kind = 'driftwood'

    const scale =
      kind === 'reef'
        ? 0.85 + Math.random() * 0.5
        : kind === 'buoy'
        ? 0.7 + Math.random() * 0.4
        : 0.6 + Math.random() * 0.5
    // Speed multiplier per kind: buoys/driftwood drift a bit slower
    // (lighter), reefs anchor at the same speed as the world scroll.
    const speedMul =
      kind === 'reef' ? 1.0 : kind === 'buoy' ? 0.85 : 0.92

    // Buoys come in red or green (port/starboard convention).
    const buoyColor = Math.random() < 0.5 ? 0xc7351c : 0x1c8a3a

    this.props.push({
      kind,
      x: this.viewport.width + 120,
      yOff:
        kind === 'reef'
          ? -2 - Math.random() * 4 // reef base sits right at the waterline
          : 0,
      scale,
      speedMul,
      phase: Math.random() * Math.PI * 2,
      rotation: kind === 'driftwood' ? (Math.random() - 0.5) * 0.4 : 0,
      reefSilhouette: kind === 'reef' ? rollReefSilhouette() : null,
      buoyColor,
    })
  }

  private draw(weather: WeatherSnapshot): void {
    const g = this.graphics
    g.clear()
    const { waterLineY } = this.viewport

    // Night-tinted palettes for each material.
    const reefDay = colorMix(0x3b3a44, 0x232229, weather.intensity)
    const reefNight = 0x0e1024
    const reefColor = colorMix(reefDay, reefNight, this.nightPhase)

    const woodDay = colorMix(0x6e4520, 0x4a2f17, weather.intensity)
    const woodNight = 0x1b1322
    const woodColor = colorMix(woodDay, woodNight, this.nightPhase)

    const foamDay = 0xf7fbff
    const foamNight = 0x9eb8c9
    const foamColor = colorMix(foamDay, foamNight, this.nightPhase)

    for (const p of this.props) {
      switch (p.kind) {
        case 'reef':
          this.drawReef(g, p, waterLineY, reefColor, foamColor)
          break
        case 'buoy':
          this.drawBuoy(g, p, waterLineY, foamColor)
          break
        case 'driftwood':
          this.drawDriftwood(g, p, waterLineY, woodColor, foamColor)
          break
      }
    }
  }

  private drawReef(
    g: Graphics,
    p: Prop,
    waterLineY: number,
    color: number,
    foamColor: number,
  ): void {
    const baseY = waterLineY + p.yOff
    const s = p.scale
    const sil = p.reefSilhouette!
    // Build a jagged polygon: bottom edge runs along the waterline,
    // top edge follows the silhouette spikes.
    const pts: number[] = []
    // Bottom corners flare slightly wider than the peak span so the
    // silhouette's outermost spikes always sit *inside* the polygon
    // (otherwise the polygon edges crisscross those peaks and the
    // fill develops a notched outline on Pixi 8's triangulator).
    pts.push(p.x - 34 * s, baseY + 6 * s)
    for (let i = 0; i < sil.peaks.length; i += 1) {
      const peak = sil.peaks[i]!
      const xx = p.x + (i / (sil.peaks.length - 1) - 0.5) * 60 * s + peak[0] * s
      const yy = baseY - peak[1] * s
      pts.push(xx, yy)
    }
    pts.push(p.x + 34 * s, baseY + 6 * s)
    g.poly(pts)
    g.fill({ color })
    // Highlight stripe near the top of the tallest peak so the rock
    // doesn't read as a flat blob — adds the suggestion of moonlight
    // catching the windward face.
    let tallestIdx = 0
    let tallestY = -Infinity
    for (let i = 0; i < sil.peaks.length; i += 1) {
      if (sil.peaks[i]![1] > tallestY) {
        tallestY = sil.peaks[i]![1]
        tallestIdx = i
      }
    }
    const highlightX = p.x + (tallestIdx / (sil.peaks.length - 1) - 0.5) * 60 * s
    const highlightY = baseY - tallestY * s
    const highlightAlpha =
      0.18 + this.nightPhase * 0.25 * Math.max(0, this.moonAltitude)
    g.moveTo(highlightX - 5 * s, highlightY + 4 * s)
    g.lineTo(highlightX + 1 * s, highlightY + 1 * s)
    g.stroke({ color: 0xffffff, alpha: highlightAlpha, width: 1.5 })

    // Foam ring around the base — pulsing with the beat so the reef
    // visibly "breathes" with the soundtrack.
    const foamWobble = 1 + Math.sin(this.elapsed * 3 + p.phase) * 0.12
    const foamPulse = 1 + this.beatPulse * 0.18
    const foamW = 28 * s * foamWobble * foamPulse
    const foamH = 4 * s * foamWobble
    g.ellipse(p.x - 6 * s, baseY + 5 * s, foamW, foamH)
    g.fill({ color: foamColor, alpha: 0.55 })
    g.ellipse(p.x + 8 * s, baseY + 5 * s, foamW * 0.85, foamH * 0.9)
    g.fill({ color: foamColor, alpha: 0.45 })
  }

  private drawBuoy(g: Graphics, p: Prop, waterLineY: number, foamColor: number): void {
    const s = p.scale
    // Buoys ride the waves — vertical bob + a little roll. Phase is
    // offset by x so neighbouring buoys bob out-of-sync (which never
    // happens but reads more natural in case two ever spawn close).
    const bobY = Math.sin(this.elapsed * 1.8 + p.x * 0.012 + p.phase) * 2.5
    const roll = Math.sin(this.elapsed * 1.2 + p.phase) * 0.18
    const cx = p.x
    const cy = waterLineY + bobY - 4 * s
    const cos = Math.cos(roll)
    const sin = Math.sin(roll)
    const rotPt = (lx: number, ly: number): [number, number] => [
      cx + lx * cos - ly * sin,
      cy + lx * sin + ly * cos,
    ]
    // Body: bell shape. Hand-built poly so we can rotate it as a rigid
    // body (Pixi 8 doesn't have an easy per-poly rotation otherwise).
    const body: Array<[number, number]> = [
      [-9 * s, 6 * s],
      [-7 * s, -4 * s],
      [-4 * s, -8 * s],
      [4 * s, -8 * s],
      [7 * s, -4 * s],
      [9 * s, 6 * s],
    ]
    const bodyFlat = body.flatMap(([lx, ly]) => rotPt(lx, ly))
    g.poly(bodyFlat)
    // Tinted to night so red buoys don't glow bright crimson in moonlight.
    const bodyColor = colorMix(p.buoyColor, 0x18142a, this.nightPhase * 0.55)
    g.fill({ color: bodyColor })
    g.stroke({ color: 0x1a0e08, alpha: 0.45, width: 1 })
    // White band across the middle.
    const band: Array<[number, number]> = [
      [-8 * s, -1 * s],
      [8 * s, -1 * s],
      [8 * s, 2 * s],
      [-8 * s, 2 * s],
    ]
    g.poly(band.flatMap(([lx, ly]) => rotPt(lx, ly)))
    g.fill({ color: 0xf6efe0, alpha: 0.95 })
    // Antenna mast on top.
    const [mx1, my1] = rotPt(0, -8 * s)
    const [mx2, my2] = rotPt(0, -16 * s)
    g.moveTo(mx1, my1).lineTo(mx2, my2)
    g.stroke({ color: 0x222024, width: 1.4 })
    // Beacon light — blinks at ~1.5 Hz, bright at night, faint by day.
    const blink = Math.sin(this.elapsed * 8 + p.phase) > 0.5 ? 1 : 0.25
    const beaconBrightness = (0.4 + this.nightPhase * 0.6) * blink
    const beaconColor = p.buoyColor === 0xc7351c ? 0xff8866 : 0x6cf08a
    const [lightX, lightY] = rotPt(0, -16 * s)
    g.circle(lightX, lightY, 2.2 * s)
    g.fill({ color: beaconColor, alpha: 0.5 + beaconBrightness * 0.5 })
    // Halo when the beacon is "on" — small dot, big diffuse glow.
    if (blink > 0.5) {
      g.circle(lightX, lightY, 6 * s)
      g.fill({ color: beaconColor, alpha: 0.18 * beaconBrightness })
    }
    // Tiny foam slap at the waterline where the bell meets the surface.
    const foamW = 11 * s
    const foamH = 2 * s * (1 + this.beatPulse * 0.5)
    g.ellipse(p.x, waterLineY + 4 * s, foamW, foamH)
    g.fill({ color: foamColor, alpha: 0.45 })
  }

  private drawDriftwood(
    g: Graphics,
    p: Prop,
    waterLineY: number,
    color: number,
    foamColor: number,
  ): void {
    const s = p.scale
    // Driftwood floats half-submerged. Slight bob & gentle rotation.
    const bobY = Math.sin(this.elapsed * 1.2 + p.phase) * 1.4
    const cx = p.x
    const cy = waterLineY + bobY + 1 * s
    const rot = p.rotation
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const rotPt = (lx: number, ly: number): [number, number] => [
      cx + lx * cos - ly * sin,
      cy + lx * sin + ly * cos,
    ]
    // Log silhouette: stretched hexagonal capsule.
    const log: Array<[number, number]> = [
      [-22 * s, 0],
      [-18 * s, -4 * s],
      [18 * s, -4 * s],
      [22 * s, 0],
      [18 * s, 4 * s],
      [-18 * s, 4 * s],
    ]
    g.poly(log.flatMap(([lx, ly]) => rotPt(lx, ly)))
    g.fill({ color })
    g.stroke({ color: 0x231406, alpha: 0.55, width: 1 })
    // Two bark grooves running along the log.
    const grooveAlpha = 0.35 - this.nightPhase * 0.2
    if (grooveAlpha > 0.05) {
      const [g1a, g1b] = rotPt(-18 * s, -1.5 * s)
      const [g2a, g2b] = rotPt(18 * s, -1.5 * s)
      g.moveTo(g1a, g1b).lineTo(g2a, g2b)
      g.stroke({ color: 0xffe7c1, alpha: grooveAlpha, width: 0.8 })
    }
    // Tiny branch stub on one end.
    const [bx1, by1] = rotPt(20 * s, 0)
    const [bx2, by2] = rotPt(26 * s, -3 * s)
    g.moveTo(bx1, by1).lineTo(bx2, by2)
    g.stroke({ color, width: 2 })
    // Foam ripple at the front.
    const foamW = 14 * s * (1 + Math.sin(this.elapsed * 4 + p.phase) * 0.15)
    g.ellipse(p.x - 8 * s, waterLineY + 5 * s, foamW, 2 * s)
    g.fill({ color: foamColor, alpha: 0.4 })
  }
}

/** Pre-rolled reef silhouette: 5–7 spike peaks, each [xOffset, height]. */
function rollReefSilhouette(): { peaks: Array<[number, number]> } {
  const count = 5 + Math.floor(Math.random() * 3)
  const peaks: Array<[number, number]> = []
  for (let i = 0; i < count; i += 1) {
    const xJitter = (Math.random() - 0.5) * 6
    const h = 14 + Math.random() * 32
    peaks.push([xJitter, h])
  }
  // Force at least one tall spire so the silhouette always has a focal point.
  const tallIdx = Math.floor(Math.random() * count)
  peaks[tallIdx]![1] = Math.max(peaks[tallIdx]![1], 38 + Math.random() * 14)
  return { peaks }
}

interface Prop {
  kind: 'reef' | 'buoy' | 'driftwood'
  x: number
  yOff: number
  scale: number
  /** Multiplier vs world scroll speed — heavier objects = lower mul. */
  speedMul: number
  /** Random phase for per-prop bob/blink desync. */
  phase: number
  /** Driftwood spins slowly; reefs/buoys ignore this. */
  rotation: number
  /** Pre-rolled reef peaks (null for non-reefs). */
  reefSilhouette: { peaks: Array<[number, number]> } | null
  /** Pre-rolled buoy color (red or green). Unused for other kinds. */
  buoyColor: number
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
