import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'
import type { TimeOfDaySnapshot } from '../systems/TimeOfDaySystem'

/**
 * Distant horizon: a parallax-scrolling coastline silhouette plus the
 * occasional fully-drawn island that drifts past, giving the player a
 * persistent sense of forward motion.
 *
 * Sits ABOVE the sky gradient but BELOW the waves so the bottom edge
 * of every silhouette tucks under the foreground sea.
 *
 * - Coastline: two parallax ribbons of stylised mountain peaks. Far
 *   ribbon is a wash of mist; near ribbon has crisper edges and a
 *   greenish tint for "land".
 * - Islands: ~every 35 seconds, a small island sprite slides past at
 *   the same speed as the near coastline, with a palm-tree silhouette
 *   for variety.
 */
export class HorizonLayer {
  readonly container = new Container()

  private readonly farRidge = new Graphics()
  private readonly nearRidge = new Graphics()
  private readonly islands = new Graphics()

  private viewport: ViewportContext
  /** Latest time-of-day, defaults to noon so headless tests still work. */
  private nightPhase = 0
  /** Run depth 0..1 — fades coastline into open ocean as stages climb. */
  private depthMood = 0
  private worldScroll = 0

  private farOffset = 0
  private nearOffset = 0
  /** Wall-clock seconds — drives lighthouse beacon rotation & pulse. */
  private elapsed = 0

  /** Active passing islands. */
  private liveIslands: Array<{
    x: number
    /** Local Y offset from the waterline. */
    yOff: number
    speed: number
    scale: number
    kind: 'palm' | 'rock' | 'lighthouse'
    /** Per-instance phase so multiple lighthouses don't blink in sync. */
    phase: number
  }> = []
  private timeSinceIsland = 0
  private nextIslandEverySec = 14

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.container.addChild(this.farRidge, this.nearRidge, this.islands)
    this.container.eventMode = 'none'
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
  }

  setTimeOfDay(snapshot: TimeOfDaySnapshot): void {
    this.nightPhase = snapshot.nightPhase
  }

  setDepthMood(t: number): void {
    this.depthMood = Math.max(0, Math.min(1, t))
  }

  setWorldScroll(px: number): void {
    this.worldScroll = Math.max(0, px)
  }

  update(dtSeconds: number, weather: WeatherSnapshot, sailMul = 1): void {
    this.elapsed += dtSeconds
    // Coastline scrolls with sailed distance so forward motion reads clearly.
    const baseSpeed = (28 + weather.windPush * 0.12) * sailMul
    this.farOffset = this.worldScroll * 0.1 + this.elapsed * baseSpeed * 0.25
    this.nearOffset = this.worldScroll * 0.26 + this.elapsed * baseSpeed * 0.55

    this.drawRidge(this.farRidge, this.farOffset, true, weather)
    this.drawRidge(this.nearRidge, this.nearOffset, false, weather)
    this.updateIslands(dtSeconds, weather)
  }

  private drawRidge(
    g: Graphics,
    offset: number,
    far: boolean,
    weather: WeatherSnapshot,
  ): void {
    const { width, waterLineY } = this.viewport
    g.clear()
    // Stylised mountain silhouette — a series of triangular peaks with
    // wobble. We render across [-200, width+200] for clean wrap.
    const baseY = waterLineY - (far ? 6 : -2)
    const depthFade = 1 - this.depthMood * 0.92
    const peakHeight = (far ? 28 : 46) * depthFade + (far ? 8 : 14) * (1 - depthFade)
    const peakSpacing = far ? 90 : 70
    // Day palette is bright wash / green land; night palette is deep
    // navy. We mix between them based on nightPhase.
    const dayWash = colorMix(0x9eb8d6, 0x303f5a, weather.intensity)
    const dayLand = colorMix(0x4f7a52, 0x2a3a3f, weather.intensity)
    const nightWash = colorMix(0x1a223d, 0x0b0d22, weather.intensity)
    const nightLand = colorMix(0x12233b, 0x080a1d, weather.intensity)
    const wash = colorMix(dayWash, nightWash, this.nightPhase)
    const land = colorMix(dayLand, nightLand, this.nightPhase)
    const color = far ? wash : land
    const alpha = (far ? 0.55 : 0.85) * depthFade
    if (alpha < 0.03) return
    const span = width + 400
    const totalPeaks = Math.ceil(span / peakSpacing) + 2
    // Bottom of the polygon hugs the waterline (+4 px bleed only) so
    // the fill never reaches the underwater fish zone.
    const polyBottom = baseY + 4
    g.moveTo(-200, polyBottom)
    for (let i = 0; i <= totalPeaks; i += 1) {
      const baseX = -200 + i * peakSpacing - (offset % peakSpacing)
      // Two-octave pseudo-noise so peaks vary in height instead of
      // being a uniform sawtooth.
      const h =
        peakHeight *
        (0.6 +
          0.25 * Math.sin(i * 1.7 + (far ? 0 : 3.1)) +
          0.15 * Math.sin(i * 0.41 + (far ? 1.3 : 0.7)))
      const tipX = baseX + peakSpacing / 2
      const tipY = baseY - h
      g.lineTo(baseX, baseY)
      g.lineTo(tipX, tipY)
    }
    g.lineTo(span - 200, baseY)
    g.lineTo(span - 200, polyBottom)
    g.closePath()
    g.fill({ color, alpha })
    // A subtle highlight along the ridge top so the near silhouette
    // reads more like land than a flat block.
    if (!far) {
      g.moveTo(-200, baseY - 1)
      for (let i = 0; i <= totalPeaks; i += 1) {
        const baseX = -200 + i * peakSpacing - (offset % peakSpacing)
        const h =
          peakHeight *
          (0.6 +
            0.25 * Math.sin(i * 1.7 + 3.1) +
            0.15 * Math.sin(i * 0.41 + 0.7))
        const tipX = baseX + peakSpacing / 2
        const tipY = baseY - h
        g.lineTo(baseX, baseY - 1)
        g.lineTo(tipX, tipY - 1)
      }
      g.stroke({ color: 0xf7e5b8, alpha: 0.25, width: 1 })
    }
  }

  private updateIslands(dtSeconds: number, weather: WeatherSnapshot): void {
    this.timeSinceIsland += dtSeconds
    if (this.timeSinceIsland > this.nextIslandEverySec) {
      this.timeSinceIsland = 0
      this.nextIslandEverySec = 22 + Math.random() * 30
      // Open ocean stages lose the coastal islands entirely.
      if (this.depthMood < 0.72 && Math.random() > this.depthMood * 0.85) {
      // Weighted kind pick: palm 50%, rock 38%, lighthouse 12%.
      // Lighthouse is the rarest because it's the most recognisable
      // landmark — too frequent and the world feels small.
      const roll = Math.random()
      let kind: 'palm' | 'rock' | 'lighthouse'
      if (roll < 0.5) kind = 'palm'
      else if (roll < 0.88) kind = 'rock'
      else kind = 'lighthouse'
      this.liveIslands.push({
        x: this.viewport.width + 120,
        yOff: -4 - Math.random() * 6,
        speed: -(18 + Math.random() * 14),
        // Lighthouse instances are slightly taller so the tower has
        // room to breathe above the base hump.
        scale:
          kind === 'lighthouse'
            ? 0.95 + Math.random() * 0.55
            : 0.75 + Math.random() * 0.6,
        kind,
        phase: Math.random() * Math.PI * 2,
      })
      }
    }
    for (const isl of this.liveIslands) {
      isl.x += isl.speed * dtSeconds
    }
    this.liveIslands = this.liveIslands.filter((isl) => isl.x > -160)

    const g = this.islands
    g.clear()
    const { waterLineY } = this.viewport
    // Same day → night mix the ridges use, applied to every island tint.
    const tintLandDay = colorMix(0x6a9b56, 0x33464f, weather.intensity)
    const tintRockDay = colorMix(0x6c6970, 0x2f2f3a, weather.intensity)
    const tintTrunkDay = colorMix(0x5a3a1e, 0x35221a, weather.intensity)
    const tintLeavesDay = colorMix(0x3d8f3a, 0x1f3a26, weather.intensity)
    const tintLandNight = 0x14253c
    const tintRockNight = 0x141826
    const tintTrunkNight = 0x0f1428
    const tintLeavesNight = 0x1a2a3a
    const tintLand = colorMix(tintLandDay, tintLandNight, this.nightPhase)
    const tintRock = colorMix(tintRockDay, tintRockNight, this.nightPhase)
    const tintTrunk = colorMix(tintTrunkDay, tintTrunkNight, this.nightPhase)
    const tintLeaves = colorMix(tintLeavesDay, tintLeavesNight, this.nightPhase)
    const alpha = 0.95 - weather.intensity * 0.2
    for (const isl of this.liveIslands) {
      const baseY = waterLineY + isl.yOff
      const s = isl.scale
      // Base land hump.
      g.ellipse(isl.x, baseY, 40 * s, 10 * s)
      g.fill({ color: isl.kind === 'palm' ? tintLand : tintRock, alpha })
      if (isl.kind === 'palm') {
        // Palm tree trunk.
        g.rect(isl.x - 2 * s, baseY - 30 * s, 4 * s, 30 * s)
        g.fill({ color: tintTrunk, alpha })
        // Five leaf fronds radiating from the top.
        const topX = isl.x
        const topY = baseY - 30 * s
        const fronds: Array<[number, number]> = [
          [-22, -6],
          [-14, -14],
          [0, -18],
          [14, -14],
          [22, -6],
        ]
        for (const [fx, fy] of fronds) {
          g.ellipse(topX + fx * s * 0.7, topY + fy * s, 12 * s, 4 * s)
          g.fill({ color: tintLeaves, alpha })
        }
      } else if (isl.kind === 'rock') {
        // Rocky outcrop: jagged peak on top of the base hump.
        g.poly([
          isl.x - 24 * s, baseY,
          isl.x - 10 * s, baseY - 28 * s,
          isl.x + 6 * s, baseY - 16 * s,
          isl.x + 20 * s, baseY - 24 * s,
          isl.x + 30 * s, baseY,
        ])
        g.fill({ color: tintRock, alpha })
        // Tiny snow cap / highlight on the top point.
        g.ellipse(isl.x - 10 * s, baseY - 28 * s, 6 * s, 2 * s)
        g.fill({ color: 0xfff8e0, alpha: alpha * 0.6 })
      } else {
        // Lighthouse on a small rocky base. The tower is a wider-at-
        // the-bottom trapezoid with alternating white/red bands, a
        // lantern room at the top, and a beacon that blinks (subtle
        // by day, prominent at night with a soft cone beam).
        this.drawLighthouse(g, isl.x, baseY, s, tintRock, alpha, isl.phase)
      }
    }
  }

  /**
   * Render one passing lighthouse landmark. Pulled into its own helper
   * because the geometry is fiddly enough to bury the simpler palm /
   * rock branches if inlined.
   */
  private drawLighthouse(
    g: Graphics,
    cx: number,
    baseY: number,
    s: number,
    rockColor: number,
    alpha: number,
    phase: number,
  ): void {
    // Rocky islet under the tower.
    g.ellipse(cx, baseY, 32 * s, 8 * s)
    g.fill({ color: rockColor, alpha })

    // Tower geometry. Wider at the base, narrower at the lantern.
    const towerHeight = 48 * s
    const baseHalf = 7 * s
    const topHalf = 5 * s
    const towerBaseY = baseY - 2 * s
    const towerTopY = towerBaseY - towerHeight
    // Tower body — paint as a single trapezoid first (white wash).
    const towerWhite = colorMix(0xf6efe0, 0x2a2a3a, this.nightPhase)
    g.poly([
      cx - baseHalf, towerBaseY,
      cx - topHalf, towerTopY,
      cx + topHalf, towerTopY,
      cx + baseHalf, towerBaseY,
    ])
    g.fill({ color: towerWhite, alpha })
    // Red horizontal bands (3 of them). We approximate the trapezoid
    // edge interpolation per band so the band edges hug the taper.
    const bandRed = colorMix(0xc7351c, 0x3c0d10, this.nightPhase)
    for (let i = 0; i < 3; i += 1) {
      const t0 = 0.15 + i * 0.28
      const t1 = t0 + 0.1
      const y0 = towerBaseY + (towerTopY - towerBaseY) * t0
      const y1 = towerBaseY + (towerTopY - towerBaseY) * t1
      const h0 = baseHalf + (topHalf - baseHalf) * t0
      const h1 = baseHalf + (topHalf - baseHalf) * t1
      g.poly([cx - h0, y0, cx - h1, y1, cx + h1, y1, cx + h0, y0])
      g.fill({ color: bandRed, alpha })
    }
    // Gallery walkway (the small balcony around the lantern room).
    const galleryY = towerTopY
    const galleryWidth = topHalf + 2 * s
    g.rect(cx - galleryWidth, galleryY - 2 * s, galleryWidth * 2, 2 * s)
    g.fill({ color: 0x2a2018, alpha })
    // Lantern room (glass enclosure for the lamp).
    const lanternHeight = 9 * s
    const lanternHalf = topHalf * 0.85
    const lanternY0 = galleryY - 2 * s
    const lanternY1 = lanternY0 - lanternHeight
    g.rect(cx - lanternHalf, lanternY1, lanternHalf * 2, lanternHeight)
    g.fill({ color: 0x352a18, alpha })
    // Domed roof sitting just above the lantern room (centre is half
    // a dome-height above the room's top edge so half the dome shows).
    const domeHalfH = 4 * s
    g.ellipse(cx, lanternY1 - 1 * s, lanternHalf + 1 * s, domeHalfH)
    g.fill({ color: 0x1c1410, alpha })
    // Antenna spire on top of the dome.
    g.rect(cx - 0.6 * s, lanternY1 - 1 * s - domeHalfH - 5 * s, 1.2 * s, 5 * s)
    g.fill({ color: 0x1c1410, alpha })

    // Beacon. Blinks at ~0.5 Hz so it reads as a slow rotating lamp.
    // Brightness ramps up with nightPhase — by day it's a faint glow,
    // at night it's clearly the headline detail.
    const blinkCycle = (Math.sin(this.elapsed * 1.6 + phase) + 1) / 2
    // Sharpen the blink so each "on" pulse is short and obvious.
    const blink = Math.pow(blinkCycle, 4)
    const dayBeacon = 0.25
    const nightBeacon = 1.0
    const beaconStrength = (dayBeacon + (nightBeacon - dayBeacon) * this.nightPhase) * blink
    const beaconCx = cx
    const beaconCy = lanternY0 - lanternHeight / 2
    // Core bulb — always visible, gets warmer at night.
    const bulbColor = colorMix(0xfff5b0, 0xffd066, this.nightPhase)
    g.circle(beaconCx, beaconCy, 2.4 * s)
    g.fill({ color: bulbColor, alpha: Math.min(1, 0.55 + beaconStrength * 0.45) })
    // Bloom halo around the bulb.
    if (beaconStrength > 0.02) {
      g.circle(beaconCx, beaconCy, 6 * s)
      g.fill({ color: bulbColor, alpha: beaconStrength * 0.35 })
      g.circle(beaconCx, beaconCy, 12 * s)
      g.fill({ color: bulbColor, alpha: beaconStrength * 0.15 })
    }
    // Cone beam — only at night, only when beacon is ON. Two cones in
    // opposite directions so the rotating-lamp illusion reads from any
    // angle. Cones fade out toward the tip.
    if (this.nightPhase > 0.05 && beaconStrength > 0.15) {
      const beamLen = 90 * s
      const beamHalfTip = 18 * s
      const beamAlpha = this.nightPhase * beaconStrength * 0.35
      // Right beam.
      g.poly([
        beaconCx, beaconCy - 1.5 * s,
        beaconCx + beamLen, beaconCy - beamHalfTip,
        beaconCx + beamLen, beaconCy + beamHalfTip,
        beaconCx, beaconCy + 1.5 * s,
      ])
      g.fill({ color: bulbColor, alpha: beamAlpha })
      // Left beam.
      g.poly([
        beaconCx, beaconCy - 1.5 * s,
        beaconCx - beamLen, beaconCy - beamHalfTip,
        beaconCx - beamLen, beaconCy + beamHalfTip,
        beaconCx, beaconCy + 1.5 * s,
      ])
      g.fill({ color: bulbColor, alpha: beamAlpha })
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
