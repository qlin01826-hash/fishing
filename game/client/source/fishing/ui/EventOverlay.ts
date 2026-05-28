import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { Direction } from '../types'

/**
 * Big pulsing text + auxiliary geometry overlays for battle events:
 *
 *  - `showFollow(fishX, fishY)`  : yellow ring around the fish + pulsing
 *                                  "FOLLOW THE FISH !" headline. A second
 *                                  yellow arc on the ring fills clockwise
 *                                  with `setFollowProgress(0..1)` so the
 *                                  player sees the "lock" charging up.
 *  - `showRun(direction)`        : red/orange "FISH IS RUNNING !" + giant
 *                                  layered double arrow (orange behind,
 *                                  blue in front) in the swipe direction.
 *  - `showStrike()`              : "STRIKE !" with swipe-up arrow.
 *  - `showMessage(text)`         : transient generic message.
 *
 * The overlay does NOT decide success/failure; it only animates +
 * exposes its bounds (the ring's current `x/y/radius`).
 */
export class EventOverlay {
  readonly container = new Container()

  private readonly bigText: Text
  private readonly subText: Text
  private readonly arrow = new Graphics()
  private readonly ring = new Graphics()
  private readonly progressArc = new Graphics()

  private mode: 'idle' | 'follow' | 'run' | 'strike' | 'message' = 'idle'
  private pulsePhase = 0
  /** Position of the highlighted fish, used for the follow ring. */
  ringX = 0
  ringY = 0
  ringRadius = 60
  private followProgress = 0
  private runDirection: Direction = 'up'
  /** Center of the screen (for big text). */
  private centerX = 0
  private centerY = 0
  /** Y where the big headline anchors during follow/run cues — set
   * by the scene so we don't fight the tension bar above us. */
  private headlineY = 60

  constructor() {
    this.bigText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 36,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffd166',
        stroke: { color: 0x000000, width: 5 },
        align: 'center',
        letterSpacing: 3,
      }),
    })
    this.bigText.anchor.set(0.5, 0.5)
    this.subText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 18,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 3 },
        align: 'center',
      }),
    })
    this.subText.anchor.set(0.5, 0.5)
    this.container.addChild(this.ring, this.progressArc, this.bigText, this.subText, this.arrow)
    this.hide()
  }

  setCenter(x: number, y: number): void {
    this.centerX = x
    this.centerY = y
  }

  /** Scene-driven layout: pass screen centre AND the Y where the
   * follow/run headline should sit (just below tension bar). */
  setLayout(centerX: number, centerY: number, headlineY: number): void {
    this.centerX = centerX
    this.centerY = centerY
    this.headlineY = headlineY
  }

  hide(): void {
    this.mode = 'idle'
    this.bigText.text = ''
    this.subText.text = ''
    this.arrow.clear()
    this.ring.clear()
    this.progressArc.clear()
    this.followProgress = 0
  }

  showStrike(): void {
    this.mode = 'strike'
    this.bigText.text = t('game.biteHint')
    this.bigText.style.fill = '#ffd166'
    this.subText.text = ''
    this.bigText.position.set(this.centerX, this.centerY - 40)
    this.drawArrow('up')
  }

  showFollow(fishX: number, fishY: number, radius: number): void {
    this.mode = 'follow'
    this.ringX = fishX
    this.ringY = fishY
    this.ringRadius = radius
    this.followProgress = 0
    this.bigText.text = t('game.followFish')
    this.bigText.style.fill = '#ffd166'
    this.bigText.position.set(this.centerX, this.headlineY)
    this.subText.text = ''
    this.arrow.clear()
  }

  showRun(direction: Direction): void {
    this.mode = 'run'
    this.runDirection = direction
    const dirLabel = t(`game.direction${capitalize(direction)}`)
    this.bigText.text = t('game.fishRunning', { dir: dirLabel })
    this.bigText.style.fill = '#ff6b6b'
    this.bigText.position.set(this.centerX, this.headlineY)
    this.subText.text = ''
    this.progressArc.clear()
    this.drawArrow(direction)
  }

  showMessage(text: string, color = '#ffefb0', sub = ''): void {
    this.mode = 'message'
    this.bigText.text = text
    this.bigText.style.fill = color
    this.bigText.position.set(this.centerX, this.centerY - 40)
    this.subText.text = sub
    this.subText.position.set(this.centerX, this.centerY)
    this.arrow.clear()
    this.ring.clear()
    this.progressArc.clear()
  }

  /** Move the follow ring along with the wandering fish. */
  setFollowTarget(x: number, y: number): void {
    if (this.mode !== 'follow') return
    this.ringX = x
    this.ringY = y
  }

  /** 0..1, drives the yellow "lock" arc that fills clockwise on the ring. */
  setFollowProgress(progress: number): void {
    if (this.mode !== 'follow') return
    this.followProgress = Math.max(0, Math.min(1, progress))
  }

  update(dtSeconds: number): void {
    this.pulsePhase += dtSeconds * 5
    const pulse = (Math.sin(this.pulsePhase) + 1) * 0.5
    if (this.mode === 'follow') {
      this.ring.clear()
      const r = this.ringRadius * (0.95 + pulse * 0.1)
      // Outer dashed-style ring (just a thin reference).
      this.ring.circle(this.ringX, this.ringY, r)
      this.ring.stroke({ color: 0xffd166, width: 4, alpha: 0.55 })
      this.ring.circle(this.ringX, this.ringY, r * 0.55)
      this.ring.stroke({ color: 0xffd166, width: 2, alpha: 0.3 })
      // Progress arc — sweeps clockwise from the top as the lock charges.
      const pa = this.progressArc
      pa.clear()
      if (this.followProgress > 0.001) {
        const start = -Math.PI / 2
        const end = start + this.followProgress * Math.PI * 2
        pa.arc(this.ringX, this.ringY, r, start, end)
        pa.stroke({ color: 0xffd166, width: 9, alpha: 0.95 })
      }
      this.bigText.scale.set(1 + pulse * 0.08)
    } else if (this.mode === 'run') {
      this.bigText.scale.set(1 + pulse * 0.18)
      this.drawArrow(this.runDirection)
    } else if (this.mode === 'strike') {
      this.bigText.scale.set(1 + pulse * 0.15)
    } else {
      this.bigText.scale.set(1)
    }
  }

  private drawArrow(direction: Direction): void {
    const g = this.arrow
    g.clear()
    const cx = this.centerX
    const cy = this.centerY + 30
    if (this.mode === 'run') {
      // Two stacked impact arrows (orange behind, blue in front) so the
      // run cue reads instantly even at the edge of vision.
      this.drawImpactArrow(g, direction, cx - 18, cy + 12, 220, 0xff8a4d, 0.7)
      this.drawImpactArrow(g, direction, cx + 18, cy - 12, 200, 0x4cb1ff, 0.95)
    } else {
      this.drawImpactArrow(g, direction, cx, cy, 130, 0xffd166, 0.9)
    }
  }

  private drawImpactArrow(
    g: Graphics,
    direction: Direction,
    cx: number,
    cy: number,
    size: number,
    color: number,
    alpha: number,
  ): void {
    const half = size / 2
    let points: number[] = []
    switch (direction) {
      case 'up':
        points = [
          cx, cy - half,
          cx - half * 0.7, cy + half * 0.2,
          cx - half * 0.25, cy + half * 0.2,
          cx - half * 0.25, cy + half,
          cx + half * 0.25, cy + half,
          cx + half * 0.25, cy + half * 0.2,
          cx + half * 0.7, cy + half * 0.2,
        ]
        break
      case 'down':
        points = [
          cx, cy + half,
          cx - half * 0.7, cy - half * 0.2,
          cx - half * 0.25, cy - half * 0.2,
          cx - half * 0.25, cy - half,
          cx + half * 0.25, cy - half,
          cx + half * 0.25, cy - half * 0.2,
          cx + half * 0.7, cy - half * 0.2,
        ]
        break
      case 'left':
        points = [
          cx - half, cy,
          cx + half * 0.2, cy - half * 0.7,
          cx + half * 0.2, cy - half * 0.25,
          cx + half, cy - half * 0.25,
          cx + half, cy + half * 0.25,
          cx + half * 0.2, cy + half * 0.25,
          cx + half * 0.2, cy + half * 0.7,
        ]
        break
      case 'right':
        points = [
          cx + half, cy,
          cx - half * 0.2, cy - half * 0.7,
          cx - half * 0.2, cy - half * 0.25,
          cx - half, cy - half * 0.25,
          cx - half, cy + half * 0.25,
          cx - half * 0.2, cy + half * 0.25,
          cx - half * 0.2, cy + half * 0.7,
        ]
        break
    }
    g.poly(points)
    g.fill({ color, alpha })
    g.stroke({ color: 0x000000, width: 3, alpha: 0.5 })
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
