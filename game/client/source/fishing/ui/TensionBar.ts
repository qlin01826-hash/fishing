import { Container, Graphics, Text, TextStyle } from 'pixi.js'

/**
 * Top-of-screen tension bar used during BattleState.
 *
 * Horizontal bar with a moving black "safe zone" segment. A white
 * tracker block moves along the bar driven by the fish (and pulled
 * back by the player's input). Staying out of the safe zone for
 * `grace_ms` snaps the line.
 *
 * Renders only — math (tracker velocity, safe zone drift) is owned by
 * `BattleState`.
 */
export class TensionBar {
  readonly container = new Container()

  private readonly bg = new Graphics()
  private readonly safeZone = new Graphics()
  private readonly tracker = new Graphics()
  private readonly graceFill = new Graphics()
  private readonly label: Text

  private barWidth = 320
  private barHeight = 18
  private warnAlpha = 0

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
    this.container.addChild(this.bg, this.safeZone, this.tracker, this.graceFill, this.label)
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
    this.draw(trackerT, safeRange, graceT, outOfZone)
  }

  private draw(trackerT: number, safeRange: [number, number], graceT: number, outOfZone: boolean): void {
    const w = this.barWidth
    const h = this.barHeight
    this.bg.clear()
    this.bg.roundRect(0, 0, w, h, 4)
    this.bg.fill({ color: 0xeeeeee, alpha: 0.95 })
    this.bg.stroke({ color: 0x000000, width: 1.5 })

    this.safeZone.clear()
    const [s, e] = safeRange
    const sx = Math.max(0, Math.min(1, s)) * w
    const ex = Math.max(0, Math.min(1, e)) * w
    this.safeZone.rect(sx, 2, Math.max(0, ex - sx), h - 4)
    this.safeZone.fill(0x111111)

    this.tracker.clear()
    const tx = Math.max(0, Math.min(1, trackerT)) * w
    // White block as tracker. Adds a red rim when outside safe zone.
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

    this.label.text = `TENSION ${outOfZone ? '!!' : ''}`
    this.label.style.fill = outOfZone ? '#ff8080' : '#ffefb0'
  }
}
