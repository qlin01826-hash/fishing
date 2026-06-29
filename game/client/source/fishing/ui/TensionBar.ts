import { Container, Graphics, Text, TextStyle } from 'pixi.js'

/**
 * Top-of-screen tension bar used during BattleState.
 *
 * Horizontal bar with a moving safe zone segment. A white tracker block
 * moves along the bar driven by the fish (and pulled back by the
 * player's input). Staying out of the safe zone for `grace_ms` snaps the
 * line.
 *
 * The safe-zone WIDTH is not constant — it grows on perfect/good rhythm
 * taps and shrinks on bad/miss. When the player drives the zone wide
 * enough to fill the whole bar, BattleState triggers a "Fish Frenzy"
 * burst (see {@link FrenzyOverlay}). To telegraph that, this bar:
 *   - tints the safe zone gold as it approaches full width
 *   - paints a glowing gold rim that pulses on each beat once the zone
 *     is wide enough
 *   - swaps to a rainbow shimmer while frenzy is actually active
 *
 * Renders only — math (tracker velocity, safe zone drift/width) is
 * owned by `BattleState`.
 */
export class TensionBar {
  readonly container = new Container()

  private readonly bg = new Graphics()
  private readonly safeZone = new Graphics()
  private readonly tracker = new Graphics()
  private readonly graceFill = new Graphics()
  private readonly meterFill = new Graphics()
  private readonly meterRim = new Graphics()
  private readonly label: Text

  private barWidth = 320
  private barHeight = 18
  private warnAlpha = 0
  /** 0..1 — how full the safe zone is relative to the whole bar. */
  private fillRatio = 0
  /** 0..1 — frenzy intensity (lerps in/out for smooth transitions). */
  private frenzyT = 0

  constructor() {
    this.label = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 11,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.label.anchor.set(0, 1)
    this.container.addChild(
      this.bg,
      this.meterFill,
      this.safeZone,
      this.meterRim,
      this.tracker,
      this.graceFill,
      this.label,
    )
  }

  setLayout(centerX: number, top: number, width: number): void {
    this.barWidth = width
    this.container.position.set(centerX - width / 2, top)
    this.label.position.set(0, -3)
    this.draw(0.5, [0.35, 0.65], 0, false)
  }

  /**
   * @param trackerT 0..1 horizontal position of tracker
   * @param safeRange [start, end] safe zone (each 0..1)
   * @param graceT 0..1 — how close we are to snapping. 1 = snap NOW.
   * @param outOfZone whether the tracker is currently outside safe zone
   */
  setState(trackerT: number, safeRange: [number, number], graceT: number, outOfZone: boolean): void {
    this.warnAlpha = outOfZone ? Math.min(1, this.warnAlpha + 0.15) : Math.max(0, this.warnAlpha - 0.08)
    const [s, e] = safeRange
    this.fillRatio = Math.max(0, Math.min(1, e - s))
    this.draw(trackerT, safeRange, graceT, outOfZone)
  }

  /** Smoothly lerp toward `target` (0 = normal, 1 = full frenzy). */
  setFrenzy(target: number, dtSeconds = 1 / 60): void {
    const k = Math.min(1, dtSeconds * 6)
    this.frenzyT += (target - this.frenzyT) * k
  }

  private draw(trackerT: number, safeRange: [number, number], graceT: number, outOfZone: boolean): void {
    const w = this.barWidth
    const h = this.barHeight
    const now = performance.now()
    const fill = this.fillRatio
    const frenzy = this.frenzyT

    this.bg.clear()
    this.bg.roundRect(0, 0, w, h, 4)
    this.bg.fill({ color: 0xeeeeee, alpha: 0.95 })
    this.bg.stroke({ color: 0x000000, width: 1.5 })

    // The safe zone shifts from neutral dark → warm gold as it widens,
    // giving the player a continuous visual signal of how close they
    // are to triggering frenzy. During frenzy itself we run a fast
    // rainbow shimmer instead.
    this.safeZone.clear()
    const [s, e] = safeRange
    const sx = Math.max(0, Math.min(1, s)) * w
    const ex = Math.max(0, Math.min(1, e)) * w
    const zoneW = Math.max(0, ex - sx)
    let zoneColor: number
    if (frenzy > 0.05) {
      // Rainbow shimmer
      const hue = (now * 0.0008) % 1
      zoneColor = hsvToRgb(hue, 0.85, 1)
    } else {
      // Lerp 0x111111 (dark) → 0xffb84a (gold) by fill ratio
      zoneColor = lerpRgb(0x111111, 0xffb84a, Math.pow(fill, 1.3))
    }
    this.safeZone.rect(sx, 2, zoneW, h - 4)
    this.safeZone.fill({ color: zoneColor, alpha: 0.92 })

    // Below-bar progress meter — same width-based fill, makes the zone
    // expansion read at a glance even when the dark zone is small.
    this.meterFill.clear()
    if (fill > 0.001) {
      this.meterFill.rect(0, h + 2, w * fill, 2)
      this.meterFill.fill({
        color: frenzy > 0.05 ? 0xfff7c0 : 0xffd166,
        alpha: 0.55 + 0.35 * fill,
      })
    }

    // Glowing rim that pulses on the audio downbeat once the zone is
    // wide enough to be interesting. During frenzy it pulses harder
    // and shifts color to white-hot gold.
    this.meterRim.clear()
    const glow = Math.max(0, fill - 0.55) / 0.45 // 0 below 55% fill, 1 at 100%
    const beatPulse = 0.5 + 0.5 * Math.sin(now * 0.012)
    if (glow > 0.01 || frenzy > 0.05) {
      const rimAlpha = Math.min(1, glow * 0.6 + frenzy * 0.5) * (0.7 + 0.3 * beatPulse)
      const rimColor = frenzy > 0.05 ? 0xffffff : 0xffd166
      this.meterRim.roundRect(-2, -2, w + 4, h + 4, 5)
      this.meterRim.stroke({ color: rimColor, width: 2 + frenzy * 2, alpha: rimAlpha })
    }

    this.tracker.clear()
    const tx = Math.max(0, Math.min(1, trackerT)) * w
    this.tracker.roundRect(tx - 6, -2, 12, h + 4, 3)
    this.tracker.fill(0xffffff)
    if (outOfZone) {
      this.tracker.roundRect(tx - 7, -3, 14, h + 6, 4)
      this.tracker.stroke({ color: 0xff5050, width: 2, alpha: this.warnAlpha })
    }

    this.graceFill.clear()
    if (graceT > 0) {
      this.graceFill.rect(0, h + 4, w * graceT, 3)
      this.graceFill.fill(0xff5050)
    }

    // Label tracks the player's state — neutral → ramping → frenzy.
    if (frenzy > 0.1) {
      this.label.text = 'FRENZY!!'
      this.label.style.fill = '#fff7c0'
    } else if (outOfZone) {
      this.label.text = 'TENSION !!'
      this.label.style.fill = '#ff8080'
    } else if (fill > 0.7) {
      this.label.text = `TENSION  ${Math.round(fill * 100)}%`
      this.label.style.fill = '#ffd166'
    } else {
      this.label.text = 'TENSION'
      this.label.style.fill = '#ffefb0'
    }
  }
}

function lerpRgb(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bC = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bC
}

function hsvToRgb(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r = 0
  let g = 0
  let b = 0
  switch (i % 6) {
    case 0:
      r = v
      g = t
      b = p
      break
    case 1:
      r = q
      g = v
      b = p
      break
    case 2:
      r = p
      g = v
      b = t
      break
    case 3:
      r = p
      g = q
      b = v
      break
    case 4:
      r = t
      g = p
      b = v
      break
    case 5:
      r = v
      g = p
      b = q
      break
  }
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
}
