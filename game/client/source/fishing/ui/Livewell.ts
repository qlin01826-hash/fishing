import { Container, Graphics, Rectangle, Text, TextStyle, type FederatedPointerEvent } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { KeeperFish, KeeperTier } from '../types'

/**
 * The Livewell — a persistent, collapsible session Fish Keeper.
 *
 * A slim "handle" button lives on the right edge; tapping it slides out a
 * frosted-glass panel that lists every fish landed this outing (newest on
 * top), coloured by rarity. Data accumulates forever across the infinite
 * fishing loop — it is never wiped by hunger or a new voyage. On each catch
 * a fleeting golden banner flashes in screen centre.
 */
export class Livewell {
  readonly container = new Container()

  private readonly handle = new Container()
  private readonly handleBg = new Graphics()
  private readonly handleLabel: Text

  private readonly panel = new Container()
  private readonly panelBg = new Graphics()
  private readonly panelTitle: Text
  private readonly listView = new Container()
  private readonly listMask = new Graphics()
  private readonly emptyLabel: Text

  private readonly flash: Text

  private readonly fish: KeeperFish[] = []
  private nextId = 1

  private open = false
  private slideT = 0

  private width = 0
  private height = 0
  private panelWidth = 300
  private handleWidth = 116
  private handleHeight = 40
  private headerHeight = 54
  private padding = 16
  private rowHeight = 34

  private scrollY = 0
  private maxScroll = 0
  private dragging = false
  private dragStartY = 0
  private dragStartScroll = 0

  private flashTimer = 0
  private flashDuration = 0

  constructor() {
    this.handleLabel = new Text({
      text: t('livewell.button', { count: '0' }),
      style: new TextStyle({
        fontSize: 15,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: 'bold',
        fill: '#bfeeff',
        stroke: { color: 0x001622, width: 3 },
      }),
    })
    this.handleLabel.anchor.set(0.5, 0.5)
    this.handle.addChild(this.handleBg, this.handleLabel)
    this.handleBg.eventMode = 'static'
    this.handleBg.cursor = 'pointer'
    this.handleBg.on('pointerdown', (e: FederatedPointerEvent) => {
      e.stopPropagation()
      this.toggle()
    })

    this.panelTitle = new Text({
      text: t('livewell.title'),
      style: new TextStyle({
        fontSize: 17,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: 'bold',
        fill: '#eaf6ff',
        stroke: { color: 0x001622, width: 3 },
      }),
    })
    this.panelTitle.anchor.set(0, 0.5)

    this.emptyLabel = new Text({
      text: t('livewell.empty'),
      style: new TextStyle({
        fontSize: 13,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#7fa8bf',
      }),
    })

    this.listView.addChild(this.emptyLabel)
    this.listView.mask = this.listMask

    // Drag-to-scroll on the panel body.
    this.panelBg.eventMode = 'static'
    this.panelBg.on('pointerdown', (e: FederatedPointerEvent) => {
      if (!this.open) return
      this.dragging = true
      this.dragStartY = e.global.y
      this.dragStartScroll = this.scrollY
    })
    this.panelBg.on('pointermove', (e: FederatedPointerEvent) => {
      if (!this.dragging) return
      const dy = e.global.y - this.dragStartY
      this.scrollY = clamp(this.dragStartScroll + dy, -this.maxScroll, 0)
      this.listView.y = this.headerHeight + this.padding + this.scrollY
    })
    const endDrag = () => {
      this.dragging = false
    }
    this.panelBg.on('pointerup', endDrag)
    this.panelBg.on('pointerupoutside', endDrag)

    this.panel.addChild(this.panelBg, this.listView, this.listMask, this.panelTitle)
    this.panel.addChild(this.handle)

    this.flash = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 30,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: 'bold',
        fill: '#ffe08a',
        stroke: { color: 0x5a3a00, width: 5 },
        dropShadow: { color: 0xffcc33, blur: 18, distance: 0, alpha: 0.9 },
        align: 'center',
      }),
    })
    this.flash.anchor.set(0.5, 0.5)
    this.flash.visible = false

    this.container.addChild(this.panel, this.flash)
  }

  setLayout(width: number, height: number): void {
    this.width = width
    this.height = height
    this.panelWidth = Math.min(320, Math.max(240, width * 0.62))

    const panelHeight = Math.min(height - 24, Math.max(220, height * 0.7))
    const panelTop = Math.max(12, (height - panelHeight) * 0.5)
    this.panel.y = panelTop

    // Frosted-glass body.
    this.panelBg.clear()
    this.panelBg.roundRect(0, 0, this.panelWidth, panelHeight, 16)
    this.panelBg.fill({ color: 0x0a1928, alpha: 0.75 })
    this.panelBg.stroke({ color: 0x3fd0ff, width: 2, alpha: 0.55 })
    this.panelBg.roundRect(0, 0, this.panelWidth, this.headerHeight, 16)
    this.panelBg.fill({ color: 0x11324a, alpha: 0.6 })
    this.panelBg.hitArea = new Rectangle(0, 0, this.panelWidth, panelHeight)

    this.panelTitle.position.set(this.padding, this.headerHeight * 0.5)

    // List clip region (below the header).
    const listTop = this.headerHeight + this.padding
    const listH = panelHeight - listTop - this.padding
    this.listMask.clear()
    this.listMask.rect(0, listTop, this.panelWidth, listH)
    this.listMask.fill(0xffffff)
    this.listView.position.set(0, listTop)
    this.scrollY = 0
    this.listView.y = listTop

    this.emptyLabel.position.set(this.padding, 6)

    // The handle rides the panel's left edge so it is always the grab-tab.
    this.handleBg.clear()
    this.handleBg.roundRect(-this.handleWidth, 0, this.handleWidth, this.handleHeight, 10)
    this.handleBg.fill({ color: 0x0a1928, alpha: 0.82 })
    this.handleBg.stroke({ color: 0x3fd0ff, width: 2, alpha: 0.7 })
    this.handleBg.hitArea = new Rectangle(-this.handleWidth, 0, this.handleWidth, this.handleHeight)
    this.handle.position.set(0, this.headerHeight * 0.5 - this.handleHeight * 0.5)
    this.handleLabel.position.set(-this.handleWidth * 0.5, this.handleHeight * 0.5)

    this.relayoutRows()
    this.applySlide()

    this.flash.position.set(width * 0.5, height * 0.42)
  }

  /** Append a landed fish, refresh the list, bump the count and flash centre-stage. */
  add(entry: Omit<KeeperFish, 'id'>): void {
    const fish: KeeperFish = { ...entry, id: this.nextId++ }
    this.fish.push(fish)
    this.handleLabel.text = t('livewell.button', { count: String(this.fish.length) })
    this.relayoutRows()
    this.flashCollected(fish)
  }

  get count(): number {
    return this.fish.length
  }

  private toggle(): void {
    this.open = !this.open
  }

  private flashCollected(fish: KeeperFish): void {
    this.flash.text = t('game.livewellCollected', { name: fish.species })
    this.flash.style.fill = tierIsGlow(fish.tier) ? '#ffb3f0' : '#ffe08a'
    this.flash.visible = true
    this.flash.alpha = 0
    this.flash.scale.set(0.7)
    this.flashTimer = 0
    this.flashDuration = 1.9
  }

  private relayoutRows(): void {
    // Drop every row except the persistent empty-state label (child 0).
    for (let i = this.listView.children.length - 1; i >= 0; i -= 1) {
      const child = this.listView.children[i]
      if (child !== this.emptyLabel) this.listView.removeChild(child)
    }
    this.emptyLabel.visible = this.fish.length === 0

    // Newest first.
    let y = 0
    for (let i = this.fish.length - 1; i >= 0; i -= 1) {
      const fish = this.fish[i]
      const glow = tierIsGlow(fish.tier)
      const color = tierColor(fish.tier)
      const row = new Text({
        text: `${fish.species}  ·  ${fish.weight}`,
        style: new TextStyle({
          fontSize: 14,
          fontFamily: 'Menlo, Consolas, monospace',
          fontWeight: glow ? 'bold' : 'normal',
          fill: color,
          ...(glow
            ? { dropShadow: { color, blur: 10, distance: 0, alpha: 0.9 } }
            : {}),
        }),
      })
      row.position.set(this.padding, y)
      const zone = new Text({
        text: fish.zone,
        style: new TextStyle({
          fontSize: 10,
          fontFamily: 'Menlo, Consolas, monospace',
          fill: '#6f96ac',
        }),
      })
      zone.position.set(this.padding, y + 17)
      this.listView.addChild(row, zone)
      y += this.rowHeight
    }

    // Recompute the scroll extent for the freshly built list.
    const panelHeight = this.panel.height || this.height * 0.7
    const listTop = this.headerHeight + this.padding
    const listH = panelHeight - listTop - this.padding
    this.maxScroll = Math.max(0, y - listH)
    this.scrollY = clamp(this.scrollY, -this.maxScroll, 0)
    this.listView.y = listTop + this.scrollY
  }

  private applySlide(): void {
    // Closed: panel parked just off the right edge (only the handle pokes in).
    // Open: panel body fully on-screen.
    const closedX = this.width
    const openX = this.width - this.panelWidth
    this.panel.x = closedX + (openX - closedX) * this.slideT
  }

  update(dtSeconds: number): void {
    const target = this.open ? 1 : 0
    if (this.slideT !== target) {
      const rate = Math.min(1, dtSeconds * 12)
      this.slideT += (target - this.slideT) * rate
      if (Math.abs(this.slideT - target) < 0.001) this.slideT = target
      this.applySlide()
    }

    if (this.flash.visible) {
      this.flashTimer += dtSeconds
      const p = this.flashTimer / this.flashDuration
      if (p >= 1) {
        this.flash.visible = false
      } else {
        // Punch-in for the first 20%, gentle rise, then fade out over the tail.
        const inP = Math.min(1, p / 0.2)
        const scale = 0.7 + (1 - Math.pow(1 - inP, 3)) * 0.35
        this.flash.scale.set(scale)
        this.flash.alpha = p < 0.65 ? Math.min(1, p / 0.2) : Math.max(0, 1 - (p - 0.65) / 0.35)
        this.flash.y = this.height * 0.42 - p * 26
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function tierIsGlow(tier: KeeperTier): boolean {
  return tier === 'epic' || tier === 'legendary' || tier === 'boss'
}

function tierColor(tier: KeeperTier): string {
  switch (tier) {
    case 'rare':
      return '#ffcf4d'
    case 'epic':
    case 'legendary':
    case 'boss':
      return '#ff8ae6'
    default:
      return '#66f0ff'
  }
}
