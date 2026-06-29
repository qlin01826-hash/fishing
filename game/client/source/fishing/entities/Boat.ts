import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'

/** One bubble in the foam wake trailing behind the boat. */
interface WakeParticle {
  /** World-space position (px). */
  x: number
  y: number
  vx: number
  /** Particle's age in seconds (counts up; max = lifetime). */
  age: number
  /** Lifetime in seconds. */
  life: number
  /** Pre-rolled per-particle size so the trail isn't a uniform ribbon. */
  baseRadius: number
}

/**
 * The player's fishing boat — drawn entirely from primitives and styled
 * to feel like a happy children's-book tugboat: rounded scarlet hull,
 * yellow racing stripe, white smiley face on the bow, cream cabin with
 * a round porthole, candy-striped mast, and a perky pennant flag.
 *
 * The boat floats with a sinusoid that intensifies in storms, and the
 * scene can sample {@link deckTopY} / {@link deckCenterX} each frame to
 * park the penguin on the deck (so it visibly rides the bob).
 *
 * The boat *position* (world coordinates) is owned by the scene so that
 * other entities (hook, line, penguin) can be parented relative to
 * either the boat or world cleanly.
 */
export class Boat {
  readonly container = new Container()
  /**
   * Foam wake trail — drawn in WORLD coords (not inside the bobbing
   * boat container) so the foam stays parked on the water instead of
   * pitching/rolling with the hull. FishingScene mounts this in the
   * above-water layer BEFORE the boat so the hull occludes the
   * leading edge of the trail.
   */
  readonly wakeContainer = new Container()
  /** World-space anchor of the rod tip. Updated each frame. */
  rodTipX = 0
  rodTipY = 0
  /** World-space anchor of the top of the deck — used by scene to
   *  park the penguin so it rides the bob. Updated each frame. */
  deckCenterX = 0
  deckTopY = 0

  private readonly hull = new Graphics()
  private readonly deck = new Graphics()
  private readonly cabin = new Graphics()
  private readonly mast = new Graphics()
  private readonly rod = new Graphics()
  private readonly face = new Graphics()
  /** Water wash over the hull when stuck inside a wave crest. */
  private readonly waveWash = new Graphics()
  /** Lantern hanging off the mast, only visible at night. */
  private readonly lantern = new Graphics()
  /** Soft warm halo cast by the lantern. Drawn BEHIND the hull so it
   *  reads as light bleeding past the boat rather than a pasted disc. */
  private readonly lanternHalo = new Graphics()
  /** Wake particle painter (single Graphics for the whole trail). */
  private readonly wakeGraphics = new Graphics()

  private baseX = 0
  private baseY = 0
  private bobPhase = Math.random() * Math.PI * 2

  /** Active wake particles. */
  private wake: WakeParticle[] = []
  /** Accumulator for fractional emissions per frame. */
  private wakeSpawnAccum = 0
  /** Last frame's beat-pulse value, used for downbeat-edge detection. */
  private prevBeatPulse = 0

  /** 0..1 lerped target for night intensity (drives lantern visibility). */
  private nightTarget = 0
  private night = 0
  /** Beat-driven flame flicker amount (0..1, lerps each frame). */
  private flameFlicker = 0

  /**
   * Lateral course error from mistimed wave-breaking (0 = on course,
   * 1 = about to capsize). Drives hull offset + extra roll.
   */
  private deviation = 0
  /** Short pulse when the player breaks a wave on-beat (0..1). */
  private waveSurge = 0
  /** Which way the boat is drifting when off-rhythm (-1 or +1). */
  private deviationDir = 1
  /** True while the boat is underway between fishing spots. */
  private sailing = false
  /** 0 = riding the crest, 1 = hull submerged in the wave trough. */
  private waveSubmerge = 0
  private waveSurfaceY = 0
  private smoothedWaveY = 0
  private waterLineY = 0
  private waveSmoothReady = false

  constructor() {
    // lanternHalo first so it sits BEHIND the hull, then the boat
    // sprites, then the lantern body on top so the flame is in front
    // of the mast.
    this.container.addChild(
      this.lanternHalo,
      this.hull,
      this.face,
      this.deck,
      this.cabin,
      this.mast,
      this.rod,
      this.waveWash,
      this.lantern,
    )
    this.wakeContainer.addChild(this.wakeGraphics)
    this.wakeContainer.eventMode = 'none'
    this.lantern.visible = false
    this.lanternHalo.visible = false
  }

  /** Re-anchor on resize. baseY usually = waterLineY. */
  setBase(x: number, y: number): void {
    this.baseX = x
    this.baseY = y
    this.draw()
  }

  /** Move the hull horizontally without rebuilding sprites (cruise drift). */
  setAnchorX(x: number): void {
    this.baseX = x
  }

  /**
   * Latch how dark it is (0 = daylight, 1 = midnight). The lantern
   * fades in/out smoothly based on this — pumped by FishingScene from
   * the TimeOfDaySystem snapshot.
   */
  setNightStrength(target: number): void {
    this.nightTarget = Math.max(0, Math.min(1, target))
  }

  /** Normalised course error 0..1 — at 1 the penguin is thrown overboard. */
  getDeviation(): number {
    return this.deviation
  }

  resetDeviation(): void {
    this.deviation = 0
    this.deviationDir = 1
    this.waveSurge = 0
    this.waveSubmerge = 0
  }

  /** Forward cruise — extra wake and a slight bow-up pitch while sailing. */
  setSailing(active: boolean): void {
    this.sailing = active
  }

  /** How deep the hull is buried in a wave (0..1). */
  getWaveSubmerge(): number {
    return this.waveSubmerge
  }

  /**
   * Feed rhythm judgements from the wave-breaking panel. Perfect/good
   * lifts the hull over the crest; misses leave the boat stuck in the wave.
   */
  applyRhythmJudgement(
    judgement: 'perfect' | 'good' | 'miss',
    beatPhase = 0,
  ): void {
    if (judgement === 'perfect') {
      this.deviation = Math.max(0, this.deviation - 0.14)
      this.waveSurge = 1
      this.waveSubmerge = Math.max(0, this.waveSubmerge - 0.45)
    } else if (judgement === 'good') {
      this.deviation = Math.max(0, this.deviation - 0.07)
      this.waveSurge = 0.65
      this.waveSubmerge = Math.max(0, this.waveSubmerge - 0.28)
    } else {
      const early = beatPhase > 0.5
      this.deviationDir = early ? -1 : 1
      this.deviation = Math.min(1, this.deviation + 0.2)
      this.waveSurge = 0
      const off = Math.min(1, Math.abs(beatPhase - (early ? 0.85 : 0.15)) * 2.2)
      this.waveSubmerge = Math.min(1, this.waveSubmerge + 0.22 + off * 0.35)
    }
  }

  /** Stable hull x for wave sampling (avoids bob ↔ wave feedback loops). */
  getHullX(): number {
    return this.baseX
  }

  /** Sampled wave height at the hull — set each frame by the scene. */
  setWaveContext(waveSurfaceY: number, waterLineY: number): void {
    this.waveSurfaceY = waveSurfaceY
    this.waterLineY = waterLineY
    if (!this.waveSmoothReady) {
      this.smoothedWaveY = waveSurfaceY
      this.waveSmoothReady = true
    }
  }

  /** Current wave-surge pulse for the ocean renderer (0..1). */
  getWaveSurge(): number {
    return this.waveSurge
  }

  /**
   * @param beatPulse 0..1, peaks on every downbeat. Used to (a) burst
   *                  extra foam at the wake's leading edge and (b)
   *                  flicker the lantern flame in time with the music.
   */
  update(
    dtSeconds: number,
    weather: WeatherSnapshot,
    elapsedMs: number,
    viewport: ViewportContext,
    beatPulse = 0,
  ): void {
    this.smoothedWaveY += (this.waveSurfaceY - this.smoothedWaveY) * Math.min(1, dtSeconds * 2.8)

    this.bobPhase += dtSeconds * (0.7 + weather.intensity * 0.4)
    const amplitude = 2.5 + weather.intensity * 5
    const surgeLift = this.waveSurge * 14
    const ridingWave = this.waveSurge > 0.06 || this.waveSubmerge > 0.1
    const crestRide = ridingWave
      ? Math.max(0, this.smoothedWaveY - this.waterLineY) * (1 - this.waveSubmerge * 0.7) * 0.28
      : 0
    const sink = this.waveSubmerge * (16 + weather.intensity * 10)
    const lift = Math.sin(this.bobPhase) * amplitude - surgeLift + crestRide - sink
    const tilt =
      Math.cos(this.bobPhase * 0.85) * (0.022 + weather.intensity * 0.06) +
      this.deviationDir * this.deviation * 0.22 -
      (this.sailing ? 0.03 : 0)
    const lateral = this.deviationDir * this.deviation * 42
    const bx = this.baseX + lateral
    const by = this.baseY + lift
    this.container.position.set(bx, by)
    this.container.rotation = tilt
    this.deviation = Math.max(0, this.deviation - dtSeconds * 0.035)
    this.waveSurge = Math.max(0, this.waveSurge - dtSeconds * 3.2)
    if (this.waveSubmerge > 0 && this.waveSurge < 0.05) {
      this.waveSubmerge = Math.max(0, this.waveSubmerge - dtSeconds * 0.06)
    }
    this.drawWaveWash()
    // Rod tip is the rightmost end of the rod in local space, rotated and translated.
    const rodLocalX = 84
    const rodLocalY = -58
    const cos = Math.cos(tilt)
    const sin = Math.sin(tilt)
    this.rodTipX = bx + rodLocalX * cos - rodLocalY * sin
    this.rodTipY = by + rodLocalX * sin + rodLocalY * cos
    // Deck-top anchor for the penguin: parked LEFT of the mast (which
    // sits at local x≈-30) so the penguin doesn't visually impale the
    // mast pole. Local deck top is at y=-8.
    const deckLocalX = -54
    const deckLocalY = -8
    this.deckCenterX = bx + deckLocalX * cos - deckLocalY * sin
    this.deckTopY = by + deckLocalX * sin + deckLocalY * cos

    // ---- Wake foam ----
    // Pass through the live `lift` so newly-spawned particles emerge at
    // the boat's CURRENT bobbing height — the trail then naturally
    // ripples in a sine wave behind the hull instead of sitting on a
    // flat waterline that disagrees with the rocking boat.
    this.updateWake(dtSeconds, weather, beatPulse, viewport, lift, bx)

    // ---- Lantern lifecycle ----
    this.night += (this.nightTarget - this.night) * Math.min(1, dtSeconds * 1.5)
    // Detect a fresh downbeat edge (pulse jumped UP this frame) to fire
    // a single flicker burst rather than a continuous wobble.
    if (beatPulse > 0.7 && this.prevBeatPulse < 0.4) {
      this.flameFlicker = 1
    }
    this.flameFlicker = Math.max(0, this.flameFlicker - dtSeconds * 4)
    this.prevBeatPulse = beatPulse
    this.drawLantern(elapsedMs)
  }

  private drawWaveWash(): void {
    const g = this.waveWash
    g.clear()
    if (this.waveSubmerge < 0.08) return
    const t = this.waveSubmerge
    g.roundRect(-88, -6, 176, 28 + t * 18, 6)
    g.fill({ color: 0x4a9fd4, alpha: t * 0.55 })
    g.ellipse(0, 8 + t * 10, 90, 6 + t * 8)
    g.fill({ color: 0xffffff, alpha: t * 0.35 })
  }

  private draw(): void {
    this.drawHull()
    this.drawFace()
    this.drawDeck()
    this.drawCabin()
    this.drawMast()
    this.drawRod()
  }

  /**
   * Emit + age + render the foam trail behind the boat. Particles live
   * in WORLD space so the trail stays parked on the water while the
   * boat itself pitches and rolls overhead.
   *
   * Beat sync: the steady "drift" emission rate scales modestly with
   * weather (rougher seas churn more foam), and on a downbeat we add a
   * concentrated extra burst so the music visually pushes the boat.
   */
  private updateWake(
    dtSeconds: number,
    weather: WeatherSnapshot,
    beatPulse: number,
    viewport: ViewportContext,
    boatLift: number,
    sternBaseX: number,
  ): void {
    // Spawn point: just behind the hull's left edge, riding the boat's
    // current bobbed height. `boatLift` is the live vertical offset
    // from `baseY` — adding it here means peaks of the bob produce
    // higher foam pads and troughs produce lower ones, so the trail
    // visibly inherits the boat's wave-bob over time.
    const sternX = sternBaseX - 80
    const sternY = this.baseY + boatLift + 4

    // Steady emission. Rate climbs gently with weather + faster on beat.
    const steady = 18 + weather.intensity * 24 + beatPulse * 28 + (this.sailing ? 22 : 0)
    this.wakeSpawnAccum += steady * dtSeconds
    while (this.wakeSpawnAccum > 1) {
      this.wakeSpawnAccum -= 1
      this.spawnWake(sternX, sternY, weather)
    }
    // Downbeat burst — fire a clump of 3–5 extra particles right on the
    // downbeat edge so the wake visibly punches with each kick of the
    // drum loop. Edge-detected via the boat's `prevBeatPulse` so we
    // don't spam every frame the pulse is high.
    if (beatPulse > 0.75 && this.prevBeatPulse < 0.4) {
      const burst = 3 + Math.floor(weather.intensity * 3)
      for (let i = 0; i < burst; i += 1) {
        this.spawnWake(sternX - i * 6, sternY + (Math.random() - 0.5) * 4, weather)
      }
    }

    // Advance + cull.
    for (const p of this.wake) {
      p.x += p.vx * dtSeconds
      // Slight vertical jitter so the trail isn't a perfect horizontal
      // ribbon; particles drift up/down on a tiny sine.
      p.y += Math.sin(p.age * 9 + p.baseRadius) * 4 * dtSeconds
      p.age += dtSeconds
    }
    const cullLeft = -120
    this.wake = this.wake.filter((p) => p.age < p.life && p.x > cullLeft)
    // Hard cap so a long session can't accumulate.
    if (this.wake.length > 80) this.wake.splice(0, this.wake.length - 80)

    // Render. Each particle is a soft white ellipse that GROWS as it
    // ages (the bubble spreads/diffuses) and fades out via alpha.
    const g = this.wakeGraphics
    g.clear()
    void viewport
    for (const p of this.wake) {
      const t01 = p.age / p.life
      const r = p.baseRadius * (1 + t01 * 1.6)
      const a = (1 - t01) * 0.72
      // Outer halo
      g.ellipse(p.x, p.y, r * 1.4, r * 0.6)
      g.fill({ color: 0xeaf6ff, alpha: a * 0.45 })
      // Inner bright cap
      g.ellipse(p.x, p.y - r * 0.15, r * 0.7, r * 0.35)
      g.fill({ color: 0xffffff, alpha: a })
    }
  }

  private spawnWake(x: number, y: number, weather: WeatherSnapshot): void {
    // Drift left with the current. Faster in windy weather.
    const driftSpeed = -(28 + weather.windPush * 0.4 + Math.random() * 14)
    this.wake.push({
      x: x + (Math.random() - 0.5) * 14,
      y: y + (Math.random() - 0.5) * 4,
      vx: driftSpeed,
      age: 0,
      life: 1.5 + Math.random() * 0.8,
      baseRadius: 3 + Math.random() * 2.5,
    })
  }

  /**
   * Draw the lantern + its warm halo. Hidden during the day; fades in
   * after dusk. The flame body flickers on the beat for life.
   */
  private drawLantern(elapsedMs: number): void {
    const halo = this.lanternHalo
    const body = this.lantern
    halo.clear()
    body.clear()
    if (this.night < 0.02) {
      halo.visible = false
      body.visible = false
      return
    }
    halo.visible = true
    body.visible = true
    // Lantern hangs from the cabin roof, on the right side of the mast.
    // Local coords (relative to boat container).
    const lx = -22
    const ly = -34
    // Halo: three stacked translucent discs of warm orange/yellow.
    // Strength scales with night, plus a small beat-driven flicker.
    const strength = this.night * (0.85 + 0.15 * Math.sin(elapsedMs * 0.012))
    const beatBoost = 1 + this.flameFlicker * 0.35
    const haloAlpha = strength * beatBoost
    halo.circle(lx, ly + 4, 84)
    halo.fill({ color: 0xffae4f, alpha: 0.045 * haloAlpha })
    halo.circle(lx, ly + 4, 58)
    halo.fill({ color: 0xffc36c, alpha: 0.08 * haloAlpha })
    halo.circle(lx, ly + 4, 36)
    halo.fill({ color: 0xffe19a, alpha: 0.13 * haloAlpha })

    // Suspension chain — a thin line from the cabin roof down to the
    // lantern's top ring.
    body.moveTo(lx, ly - 14)
    body.lineTo(lx, ly - 6)
    body.stroke({ color: 0x3a2810, width: 1, alpha: this.night })
    // Top ring
    body.rect(lx - 4, ly - 6, 8, 2)
    body.fill({ color: 0x3a2810, alpha: this.night })
    // Lantern body — a small lantern shape (trapezoid + glass).
    body.poly([lx - 6, ly - 4, lx + 6, ly - 4, lx + 5, ly + 8, lx - 5, ly + 8])
    body.fill({ color: 0x6a3a1a, alpha: this.night })
    // Glass: amber pane.
    body.rect(lx - 4, ly - 2, 8, 8)
    body.fill({ color: 0xffd078, alpha: this.night * 0.95 })
    // Flame: small flicker triangle, jittered by the flame flicker amount.
    const flameJitterX = (Math.random() - 0.5) * this.flameFlicker * 2
    const flameTop = ly + 1 + this.flameFlicker * -1.6
    body.poly([
      lx - 2 + flameJitterX, ly + 5,
      lx + flameJitterX, flameTop,
      lx + 2 + flameJitterX, ly + 5,
    ])
    body.fill({ color: 0xff9a3c, alpha: this.night })
    body.circle(lx + flameJitterX, ly + 4, 1.4)
    body.fill({ color: 0xfff6c0, alpha: this.night })
    // Base of lantern.
    body.rect(lx - 5, ly + 8, 10, 2)
    body.fill({ color: 0x3a2810, alpha: this.night })
  }

  /**
   * Rounded "bathtub" hull with a yellow racing stripe and white trim.
   * Two ellipses give the cartoony belly shape; a polygon clip would be
   * more efficient but ellipses keep the silhouette friendly.
   */
  private drawHull(): void {
    const g = this.hull
    g.clear()
    // Soft drop shadow under the hull on the water.
    g.ellipse(0, 38, 96, 8)
    g.fill({ color: 0x0a1830, alpha: 0.18 })
    // Main hull — rounded scarlet belly.
    g.ellipse(0, 22, 96, 22)
    g.fill(0xe14b4b)
    // White trim above the waterline.
    g.roundRect(-92, 0, 184, 8, 4)
    g.fill(0xfff5e0)
    // Yellow racing stripe just below the trim.
    g.rect(-90, 8, 180, 4)
    g.fill(0xffd24a)
    // Lower-hull darker red curve gives shading.
    g.ellipse(0, 30, 84, 14)
    g.fill({ color: 0xa72d2d, alpha: 0.45 })
    // Three white portholes along the side.
    for (const px of [-50, -16, 18]) {
      g.circle(px, 18, 5)
      g.fill(0xfff5e0)
      g.circle(px, 18, 3)
      g.fill(0x71a3d6)
    }
  }

  /**
   * Friendly face on the bow (right side of hull). Two big eyes + a
   * curved smile. Faces forward (right) since the rod casts off the
   * right side of the boat.
   */
  private drawFace(): void {
    const g = this.face
    g.clear()
    // Eyes
    g.circle(58, 16, 6)
    g.fill(0xffffff)
    g.circle(78, 16, 6)
    g.fill(0xffffff)
    g.circle(60, 17, 3)
    g.fill(0x1a1a2e)
    g.circle(80, 17, 3)
    g.fill(0x1a1a2e)
    // Smile (a thick arc using two stroked lines for a chunky look).
    g.moveTo(54, 28)
    g.quadraticCurveTo(68, 38, 84, 28)
    g.stroke({ color: 0x1a1a2e, width: 3, cap: 'round' })
    // Rosy cheek.
    g.circle(50, 24, 3)
    g.fill({ color: 0xff9aa2, alpha: 0.7 })
  }

  /**
   * Deck planks — bright wood, only on the left half so the penguin
   * has a clear surface to stand on without the cabin behind it.
   */
  private drawDeck(): void {
    const g = this.deck
    g.clear()
    // Cream-coloured plank.
    g.roundRect(-78, -8, 88, 12, 3)
    g.fill(0xe8c79a)
    // Plank lines
    for (let i = -68; i <= 0; i += 18) {
      g.rect(i, -8, 1, 12)
      g.fill({ color: 0x8c5a2c, alpha: 0.45 })
    }
    // Deck rim shadow under the planks.
    g.rect(-78, 4, 88, 2)
    g.fill({ color: 0x6c4a26, alpha: 0.4 })
  }

  /**
   * Cabin with porthole — sits on the right half of the deck. White-
   * cream box with a curved roof; gives the boat a pleasing silhouette
   * and an obvious "front" / "back".
   */
  private drawCabin(): void {
    const g = this.cabin
    g.clear()
    // Cabin body
    g.roundRect(10, -34, 38, 30, 6)
    g.fill(0xfff5e0)
    // Sloped roof accent
    g.roundRect(8, -34, 42, 6, 3)
    g.fill(0x4a8fc7)
    // Round porthole
    g.circle(29, -18, 6)
    g.fill(0x71a3d6)
    g.circle(29, -18, 6)
    g.stroke({ color: 0xfff5e0, width: 2 })
    // Tiny glint highlight on the porthole.
    g.circle(27, -20, 1.6)
    g.fill({ color: 0xffffff, alpha: 0.8 })
  }

  private drawMast(): void {
    const g = this.mast
    g.clear()
    // Mast pole — candy-striped (red + white) for a cheerful look.
    g.rect(-32, -70, 4, 62)
    g.fill(0xfff5e0)
    for (let y = -68; y < -8; y += 8) {
      g.rect(-32, y, 4, 4)
      g.fill(0xe14b4b)
    }
    // Mast cap ball.
    g.circle(-30, -72, 4)
    g.fill(0xffd24a)
    // Triangular pennant flag flapping right.
    g.poly([-28, -70, -8, -62, -28, -56])
    g.fill(0xff6b6b)
    g.moveTo(-28, -70)
    g.lineTo(-28, -56)
    g.stroke({ color: 0xa72d2d, width: 1, alpha: 0.6 })
  }

  private drawRod(): void {
    const g = this.rod
    g.clear()
    // Rod — light tan, from deck (right edge of cabin) up & right to tip.
    g.moveTo(48, -8)
    g.lineTo(84, -58)
    g.stroke({ color: 0x3a2310, width: 4, cap: 'round' })
    g.moveTo(48, -8)
    g.lineTo(84, -58)
    g.stroke({ color: 0xd4a86a, width: 2, alpha: 0.7 })
    // Reel housing at base of rod.
    g.circle(48, -6, 6)
    g.fill(0x2b2b2b)
    g.circle(48, -6, 3)
    g.fill(0xc0c0c0)
    g.circle(48, -6, 1)
    g.fill(0xfff5e0)
  }
}
