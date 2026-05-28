import { Application, Ticker } from 'pixi.js'
import { Input } from './Input'

export interface GameScene {
  init(): void
  update(deltaSeconds: number): void
  onResize(width: number, height: number): void
  destroy(): void
}

export class Engine {
  readonly app: Application
  readonly input: Input

  private scene: GameScene | null = null
  private running = false
  private paused = false
  private _tick = 0

  constructor(app: Application) {
    this.app = app
    this.input = new Input()
  }

  setScene(scene: GameScene): void {
    if (this.scene) {
      this.scene.destroy()
    }

    this.scene = scene
    scene.init()
  }

  start(): void {
    if (this.running) return

    this.running = true
    this.paused = false
    this.app.ticker.add(this.gameLoop, this)
  }

  play(): void {
    this.paused = false
  }

  pause(): void {
    this.paused = true
  }

  reset(): void {
    this._tick = 0

    if (this.scene) {
      this.scene.destroy()
      this.scene.init()
    }
  }

  destroy(): void {
    this.running = false
    this.app.ticker.remove(this.gameLoop, this)
    this.scene?.destroy()
    this.scene = null
    this.input.destroy()
  }

  get tick(): number {
    return this._tick
  }

  private gameLoop(ticker: Ticker): void {
    if (!this.running || this.paused || !this.scene) {
      return
    }

    this._tick += 1
    this.scene.update(ticker.deltaMS / 1000)
    this.input.update()
  }
}
