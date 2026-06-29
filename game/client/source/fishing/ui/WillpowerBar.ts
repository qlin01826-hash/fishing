import { Container, Graphics, Text, TextStyle } from 'pixi.js'

/**
 * Right-edge vertical bar showing how much willpower the fish has left.
 * Drains to zero = fish caught.
 */
export class WillpowerBar {
  readonly container = new Container()
  private readonly bg = new Graphics()
  private readonly fill = new Graphics()
  private readonly label: Text
  private barHeight = 280
  private barWidth = 14

  constructor() {
    this.label = new Text({
      text: 'FISH',
      style: new TextStyle({
        fontSize: 10,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.label.anchor.set(0.5, 1)
    this.container.addChild(this.bg, this.fill, this.label)
  }

  setLayout(rightX: number, centerY: number, height: number): void {
    this.barHeight = height
    this.container.position.set(rightX - this.barWidth, centerY - height / 2)
    this.label.position.set(this.barWidth / 2, -4)
    this.draw(1, 0xc580ff)
  }

  setState(willpower01: number, tintColor: number): void {
    this.draw(willpower01, tintColor)
  }

  private draw(t: number, tintColor: number): void {
    const value = Math.max(0, Math.min(1, t))
    this.bg.clear()
    this.bg.roundRect(0, 0, this.barWidth, this.barHeight, 4)
    this.bg.fill({ color: 0x000000, alpha: 0.55 })
    this.bg.stroke({ color: 0xffefb0, width: 1.5, alpha: 0.85 })
    this.fill.clear()
    const fillH = (this.barHeight - 4) * value
    this.fill.roundRect(2, this.barHeight - 2 - fillH, this.barWidth - 4, fillH, 3)
    this.fill.fill(tintColor)
  }
}
