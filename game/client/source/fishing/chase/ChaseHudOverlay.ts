import { Container, Text, TextStyle } from 'pixi.js'

/** Subtle combo readout — screen-blended, never blocks the chase lane. */
export class ChaseHudOverlay {
  readonly container = new Container()
  private readonly combo = new Text({
    text: '',
    style: new TextStyle({
      fontFamily: 'Helvetica Neue, Arial, sans-serif',
      fontSize: 28,
      fontWeight: '300',
      fill: '#e8f4ff',
      letterSpacing: 4,
    }),
  })

  constructor() {
    this.combo.anchor.set(1, 0)
    this.combo.alpha = 0
    this.combo.blendMode = 'screen'
    this.container.addChild(this.combo)
  }

  setLayout(width: number, _height: number): void {
    this.combo.position.set(width - 18, 14)
  }

  setComboCount(count: number): void {
    if (count >= 2) {
      this.combo.text = `COMBO ${count}`
      this.combo.alpha = 0.4
    } else {
      this.combo.alpha = 0
    }
  }
}
