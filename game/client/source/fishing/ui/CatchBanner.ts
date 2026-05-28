import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import { rarityToColor } from '../data/FishCatalog'
import type { FishDef } from '../types'

/**
 * Slide-in result banner shown after a successful catch.
 * Auto-hides after `holdMs`; the scene can also force-hide it.
 */
export class CatchBanner {
  readonly container = new Container()

  private readonly bg = new Graphics()
  private readonly tag = new Graphics()
  private readonly title: Text
  private readonly subtitle: Text

  private state: 'idle' | 'in' | 'hold' | 'out' = 'idle'
  private timer = 0
  private fromX = 0
  private toX = 0
  private centerY = 0

  constructor() {
    this.title = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 24,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#fff7e1',
        stroke: { color: 0x000000, width: 4 },
      }),
    })
    this.title.anchor.set(0.5, 0.5)
    this.subtitle = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 14,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.subtitle.anchor.set(0.5, 0)
    this.container.addChild(this.bg, this.tag, this.title, this.subtitle)
    this.container.visible = false
  }

  show(viewportWidth: number, viewportHeight: number, fish: FishDef, score: number, bonus: string | null): void {
    const bannerWidth = Math.min(520, viewportWidth - 80)
    const bannerHeight = 88
    this.bg.clear()
    this.bg.roundRect(0, 0, bannerWidth, bannerHeight, 14)
    this.bg.fill({ color: 0x111111, alpha: 0.92 })
    this.bg.stroke({ color: rarityToColor(fish.rarity), width: 3 })
    this.tag.clear()
    this.tag.roundRect(0, 0, 14, bannerHeight, 4)
    this.tag.fill(fish.color)
    const rarityLabel = t(`fish.rarity${capitalize(fish.rarity)}`)
    const name = t(`fish.${fish.i18nKey}`)
    this.title.text = t('game.caughtBanner', { rarity: rarityLabel, name, score: String(score) })
    this.title.position.set(bannerWidth / 2, 32)
    this.subtitle.text = bonus ?? ''
    this.subtitle.position.set(bannerWidth / 2, 58)

    this.centerY = viewportHeight * 0.32
    this.toX = (viewportWidth - bannerWidth) / 2
    this.fromX = -bannerWidth - 20
    this.container.position.set(this.fromX, this.centerY)
    this.container.visible = true
    this.state = 'in'
    this.timer = 0
  }

  /** Returns true the frame the banner finishes its exit. */
  update(dtSeconds: number): boolean {
    if (this.state === 'idle') return false
    this.timer += dtSeconds
    if (this.state === 'in') {
      const p = Math.min(1, this.timer / 0.4)
      const eased = 1 - Math.pow(1 - p, 3)
      this.container.position.set(this.fromX + (this.toX - this.fromX) * eased, this.centerY)
      if (p >= 1) {
        this.state = 'hold'
        this.timer = 0
      }
    } else if (this.state === 'hold') {
      if (this.timer > 2.4) {
        this.state = 'out'
        this.timer = 0
      }
    } else if (this.state === 'out') {
      const p = Math.min(1, this.timer / 0.35)
      const eased = p * p
      this.container.position.set(this.toX + 400 * eased, this.centerY)
      this.container.alpha = 1 - p
      if (p >= 1) {
        this.container.visible = false
        this.container.alpha = 1
        this.state = 'idle'
        return true
      }
    }
    return false
  }

  hide(): void {
    this.container.visible = false
    this.state = 'idle'
    this.timer = 0
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
