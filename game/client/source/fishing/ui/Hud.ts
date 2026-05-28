import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { WeatherSnapshot } from '../types'

/**
 * Top-of-screen HUD: score, best, hunger meter, wind tier label.
 *
 * Self-contained: the scene only needs to call `setMetrics(...)` /
 * `setLayout(...)` whenever state changes.
 */
export class Hud {
  readonly container = new Container()

  private readonly scoreText: Text
  private readonly windText: Text
  private readonly hungerLabel: Text
  private readonly hungerBg = new Graphics()
  private readonly hungerFill = new Graphics()

  private viewportWidth = 0
  private hunger = 0
  private weather: WeatherSnapshot | null = null

  constructor() {
    this.scoreText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 18,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.windText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 14,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.hungerLabel = new Text({
      text: t('game.hungerLabel'),
      style: new TextStyle({
        fontSize: 12,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.container.addChild(this.scoreText, this.windText, this.hungerLabel, this.hungerBg, this.hungerFill)
  }

  setLayout(width: number, _height: number): void {
    this.viewportWidth = width
    const compact = width < 720
    this.scoreText.style.fontSize = compact ? 14 : 18
    this.windText.style.fontSize = compact ? 12 : 14
    this.hungerLabel.style.fontSize = compact ? 10 : 12
    const labelX = compact ? 8 : 12
    this.scoreText.position.set(labelX, compact ? 6 : 10)
    this.hungerLabel.position.set(labelX, compact ? 28 : 36)
    const barX = compact ? 92 : 120
    const barY = compact ? 30 : 36
    this.hungerBg.position.set(barX, barY)
    this.hungerFill.position.set(barX, barY)
    this.windText.anchor.set(1, 0)
    this.windText.position.set(width - (compact ? 8 : 12), compact ? 6 : 10)
    this.draw()
  }

  setMetrics(score: number, best: number, hunger: number, weather: WeatherSnapshot): void {
    this.scoreText.text = t('game.scoreLine', { score: String(score), best: String(best) })
    this.windText.text = `${t('game.windLabel', { level: t(`game.wind${capitalize(weather.tier)}`) })}`
    this.hunger = hunger
    this.weather = weather
    this.draw()
  }

  private draw(): void {
    const compact = this.viewportWidth < 720
    const barWidth = Math.min(compact ? 160 : 220, this.viewportWidth - (compact ? 160 : 200))
    const barHeight = compact ? 10 : 12
    this.hungerBg.clear()
    this.hungerBg.roundRect(0, 0, barWidth, barHeight, 4)
    this.hungerBg.fill({ color: 0x000000, alpha: 0.4 })
    this.hungerBg.stroke({ color: 0xffefb0, width: 1, alpha: 0.8 })
    this.hungerFill.clear()
    const fillColor = hungerColor(this.hunger)
    this.hungerFill.roundRect(2, 2, Math.max(0, (barWidth - 4) * this.hunger), barHeight - 4, 3)
    this.hungerFill.fill(fillColor)
    if (this.weather && this.weather.tier === 'storm') {
      // Pulse the bar in a storm to nudge the player to fish
      const pulse = (Math.sin(performance.now() * 0.006) + 1) * 0.5
      this.hungerFill.alpha = 0.6 + 0.4 * pulse
    } else {
      this.hungerFill.alpha = 1
    }
  }
}

function hungerColor(h: number): number {
  if (h < 0.3) return 0x7ed957
  if (h < 0.6) return 0xf2c94c
  if (h < 0.85) return 0xf2994a
  return 0xeb5757
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
