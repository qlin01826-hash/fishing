import { Container, FederatedPointerEvent, Graphics, Rectangle, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import { FISHING_CONSTANTS } from '../types'

interface ButtonState {
  container: Container
  bg: Graphics
  label: Text
  width: number
  height: number
  pressedFlash: number
}

/**
 * Two on-screen buttons used during WaitingState:
 *   REEL      — twitches the line up a little (throttled 8 Hz)
 *   FAST REEL — yanks the hook out of the water back to the rod
 *
 * Both raise plain callbacks; throttle bookkeeping lives here so the
 * scene/state classes stay simple.
 */
export class ReelButtons {
  readonly container = new Container()
  private reelBtn: ButtonState
  private fastBtn: ButtonState
  private lastReelMs = 0

  onReel: (() => void) | null = null
  onFastReel: (() => void) | null = null

  constructor() {
    this.reelBtn = this.makeButton(t('game.reelButton'), 0xffd166, 120, 56)
    this.fastBtn = this.makeButton(t('game.snapReelButton'), 0xb0b0b0, 120, 38)
    this.container.addChild(this.reelBtn.container, this.fastBtn.container)
    this.attach(this.reelBtn, () => this.handleReel())
    this.attach(this.fastBtn, () => this.handleFastReel())
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y)
    this.reelBtn.container.position.set(0, 0)
    this.fastBtn.container.position.set(0, 64)
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible
  }

  update(dtSeconds: number): void {
    this.reelBtn.pressedFlash = Math.max(0, this.reelBtn.pressedFlash - dtSeconds * 6)
    this.fastBtn.pressedFlash = Math.max(0, this.fastBtn.pressedFlash - dtSeconds * 6)
    this.redraw(this.reelBtn, 0xffd166)
    this.redraw(this.fastBtn, 0xb0b0b0)
  }

  private handleReel(): void {
    const now = performance.now()
    if (now - this.lastReelMs < FISHING_CONSTANTS.reel_throttle_ms) return
    this.lastReelMs = now
    this.reelBtn.pressedFlash = 1
    this.onReel?.()
  }

  private handleFastReel(): void {
    this.fastBtn.pressedFlash = 1
    this.onFastReel?.()
  }

  private makeButton(text: string, color: number, width: number, height: number): ButtonState {
    const container = new Container()
    const bg = new Graphics()
    const label = new Text({
      text,
      style: new TextStyle({
        fontSize: 16,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#181000',
        stroke: { color: 0xffffff, width: 2 },
      }),
    })
    label.anchor.set(0.5, 0.5)
    label.position.set(width / 2, height / 2)
    container.addChild(bg, label)
    const state: ButtonState = { container, bg, label, width, height, pressedFlash: 0 }
    this.redraw(state, color)
    return state
  }

  private attach(button: ButtonState, handler: () => void): void {
    button.bg.eventMode = 'static'
    button.bg.cursor = 'pointer'
    button.bg.hitArea = new Rectangle(0, 0, button.width, button.height)
    button.bg.on('pointerdown', (event: FederatedPointerEvent) => {
      event.stopPropagation()
      handler()
    })
  }

  private redraw(button: ButtonState, color: number): void {
    const g = button.bg
    g.clear()
    g.roundRect(0, 0, button.width, button.height, 10)
    g.fill({ color, alpha: 0.85 + button.pressedFlash * 0.15 })
    g.stroke({ color: 0x000000, width: 2, alpha: 0.5 })
    if (button.pressedFlash > 0) {
      g.roundRect(0, 0, button.width, button.height, 10)
      g.fill({ color: 0xffffff, alpha: button.pressedFlash * 0.25 })
    }
    g.hitArea = new Rectangle(0, 0, button.width, button.height)
  }
}
