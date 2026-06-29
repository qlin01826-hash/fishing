import { Container, FederatedPointerEvent, Graphics, Rectangle, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { BeatClock } from '../systems/BeatClock'
import type { TapJudgement } from './PullPanel'

export type LureDirection = 'left' | 'right'

interface PadPointer {
  pointerId: number
  startX: number
  dir: LureDirection | null
}

interface PadSide {
  container: Container
  bg: Graphics
  arrow: Graphics
  telegraph: Graphics
  label: Text
  hint: Text
  cx: number
  cy: number
  radius: number
  swipeDir: LureDirection | null
  active: boolean
  flash: number
}

/**
 * Dual bottom-corner swipe pads for the lure / whistle-command phase.
 * During the listen phase the player echoes the penguin's rhythm pattern
 * by sliding BOTH pads in the signaled direction on each hit beat.
 */
export class LurePads {
  readonly container = new Container()

  private readonly left: PadSide
  private readonly right: PadSide
  private commandDir: LureDirection = 'left'
  private progress = 0
  private progressTarget = 5
  private pulse = 0
  /** idle → preview (wind-up) → hit (accept swipe). */
  private padPhase: 'idle' | 'preview' | 'hit' = 'idle'
  private listenActive = false
  private readonly pointers = new Map<number, PadPointer>()
  private readonly swipeThreshold = 28
  private readonly keysDown = new Set<string>()
  private keyboardLatched = false
  private beatClock: BeatClock | null = null
  private readonly perfectWindowMs = 90
  private readonly goodWindowMs = 200

  /** Fires when both pads swipe together; timing is scored like PullPanel. */
  onDualSwipe: (judgement: TapJudgement, dirOk: boolean) => void = () => {}

  constructor() {
    this.left = this.makePad(t('game.lurePadLeft'))
    this.right = this.makePad(t('game.lurePadRight'))
    this.container.addChild(this.left.container, this.right.container)
    this.attachPad(this.left, 'left')
    this.attachPad(this.right, 'right')
    this.container.visible = false
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
  }

  setLayout(width: number, height: number): void {
    const minDim = Math.min(width, height)
    const radius = Math.max(48, Math.min(78, minDim * 0.11))
    const margin = radius + 18
    const cy = height - radius - 20
    this.layoutPad(this.left, margin, cy, radius)
    this.layoutPad(this.right, width - margin, cy, radius)
  }

  setVisible(visible: boolean): void {
    this.container.visible = visible
    if (!visible) {
      this.pointers.clear()
      this.keysDown.clear()
      this.listenActive = false
      this.padPhase = 'idle'
    }
  }

  setCommandDirection(dir: LureDirection): void {
    this.commandDir = dir
    this.left.swipeDir = null
    this.right.swipeDir = null
  }

  setProgress(current: number, target: number): void {
    this.progress = current
    this.progressTarget = target
  }

  /** Wind-up: show direction + shrinking ring before the hit beat. */
  setPadPhase(phase: 'idle' | 'preview' | 'hit'): void {
    this.padPhase = phase
    if (phase !== 'hit') {
      this.listenActive = false
      this.left.swipeDir = null
      this.right.swipeDir = null
      this.left.active = false
      this.right.active = false
      this.pointers.clear()
    }
  }

  /** True on the hit beat — dual swipes are accepted and rhythm-scored. */
  setListenActive(active: boolean): void {
    this.listenActive = active
    if (active) this.padPhase = 'hit'
    if (!active) {
      this.left.swipeDir = null
      this.right.swipeDir = null
      this.left.active = false
      this.right.active = false
      this.pointers.clear()
    }
  }

  closeRound(): void {
    this.setListenActive(false)
    this.setPadPhase('idle')
  }

  reset(): void {
    this.closeRound()
    this.progress = 0
    this.progressTarget = 5
    this.keysDown.clear()
  }

  keyboardEvent(down: boolean, code: string): void {
    if (!this.container.visible) return
    const relevant =
      code === 'KeyA' ||
      code === 'KeyD' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'KeyW' ||
      code === 'KeyS'
    if (!relevant) return
    if (down) this.keysDown.add(code)
    else this.keysDown.delete(code)
    if (!down && this.keysDown.size === 0) this.keyboardLatched = false
    if (!this.listenActive || !down) return
    this.tryResolveKeyboard()
  }

  private tryResolveKeyboard(): void {
    if (!this.listenActive || this.keyboardLatched) return
    const cmd = this.commandDir
    let dirOk = false
    if (cmd === 'left') {
      const pairA = this.keysDown.has('KeyA') && this.keysDown.has('ArrowLeft')
      const pairWasd = this.keysDown.has('KeyA') && this.keysDown.has('KeyS')
      dirOk = pairA || pairWasd
    } else {
      const pairD = this.keysDown.has('KeyD') && this.keysDown.has('ArrowRight')
      const pairWasd = this.keysDown.has('KeyD') && this.keysDown.has('KeyW')
      dirOk = pairD || pairWasd
    }
    if (dirOk) this.emitSwipe(dirOk)
  }

  update(dtSeconds: number, nowMs = performance.now()): void {
    this.pulse += dtSeconds * 4
    let telegraph = 0
    let beatFlash = 0
    if (this.beatClock?.started && this.padPhase !== 'idle') {
      const phase = this.beatClock.phase(nowMs)
      if (this.padPhase === 'preview') {
        // Ring closes across the full beat — peaks right before the hit downbeat.
        telegraph = 1 - phase
      } else if (this.padPhase === 'hit') {
        beatFlash = phase < 0.32 ? 1 - phase / 0.32 : 0
      }
    }
    const p = (Math.sin(this.pulse) + 1) * 0.5
    this.redrawPad(this.left, p, telegraph, beatFlash)
    this.redrawPad(this.right, p, telegraph, beatFlash)
    this.left.flash = Math.max(0, this.left.flash - dtSeconds * 4)
    this.right.flash = Math.max(0, this.right.flash - dtSeconds * 4)
  }

  private makePad(title: string): PadSide {
    const container = new Container()
    const bg = new Graphics()
    const arrow = new Graphics()
    const telegraph = new Graphics()
    const label = new Text({
      text: title,
      style: new TextStyle({
        fontSize: 13,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#fff7e1',
        stroke: { color: 0x000000, width: 2 },
        align: 'center',
      }),
    })
    label.anchor.set(0.5, 0.5)
    const hint = new Text({
      text: '← →',
      style: new TextStyle({
        fontSize: 11,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    hint.anchor.set(0.5, 0.5)
    container.addChild(bg, telegraph, arrow, label, hint)
    return {
      container,
      bg,
      arrow,
      telegraph,
      label,
      hint,
      cx: 0,
      cy: 0,
      radius: 60,
      swipeDir: null,
      active: false,
      flash: 0,
    }
  }

  private layoutPad(pad: PadSide, cx: number, cy: number, radius: number): void {
    pad.cx = cx
    pad.cy = cy
    pad.radius = radius
    pad.container.position.set(cx, cy)
    pad.label.position.set(0, radius * 0.42)
    pad.hint.position.set(0, radius * 0.68)
    pad.bg.hitArea = new Rectangle(-radius, -radius, radius * 2, radius * 2)
  }

  private attachPad(pad: PadSide, side: 'left' | 'right'): void {
    pad.bg.eventMode = 'static'
    pad.bg.cursor = 'pointer'
    pad.bg.on('pointerdown', (e: FederatedPointerEvent) => this.onPadDown(e, side))
    pad.bg.on('pointermove', (e: FederatedPointerEvent) => this.onPadMove(e, side))
    pad.bg.on('pointerup', (e: FederatedPointerEvent) => this.onPadUp(e, side))
    pad.bg.on('pointerupoutside', (e: FederatedPointerEvent) => this.onPadUp(e, side))
    pad.bg.on('pointercancel', (e: FederatedPointerEvent) => this.onPadUp(e, side))
  }

  private onPadDown(e: FederatedPointerEvent, side: 'left' | 'right'): void {
    if (!this.listenActive) return
    e.stopPropagation()
    const pad = side === 'left' ? this.left : this.right
    pad.active = true
    const local = pad.container.toLocal(e.global)
    this.pointers.set(e.pointerId, {
      pointerId: e.pointerId,
      startX: local.x,
      dir: null,
    })
  }

  private onPadMove(e: FederatedPointerEvent, side: 'left' | 'right'): void {
    if (!this.listenActive) return
    const rec = this.pointers.get(e.pointerId)
    if (!rec) return
    const pad = side === 'left' ? this.left : this.right
    const local = pad.container.toLocal(e.global)
    const dx = local.x - rec.startX
    if (Math.abs(dx) >= this.swipeThreshold) {
      rec.dir = dx < 0 ? 'left' : 'right'
      pad.swipeDir = rec.dir
    }
    this.tryResolveTouch()
  }

  private onPadUp(e: FederatedPointerEvent, side: 'left' | 'right'): void {
    const pad = side === 'left' ? this.left : this.right
    pad.active = false
    this.pointers.delete(e.pointerId)
    this.tryResolveTouch()
  }

  private tryResolveTouch(): void {
    if (!this.listenActive) return
    const cmd = this.commandDir
    const dirOk = this.left.swipeDir === cmd && this.right.swipeDir === cmd
    if (dirOk) this.emitSwipe(dirOk)
  }

  private judgeTiming(nowMs: number): TapJudgement {
    if (!this.beatClock || !this.beatClock.started) return 'good'
    const offset = Math.abs(this.beatClock.msFromNearestBeat(nowMs))
    if (offset <= this.perfectWindowMs) return 'perfect'
    if (offset <= this.goodWindowMs) return 'good'
    return 'miss'
  }

  private emitSwipe(dirOk: boolean): void {
    if (!this.listenActive) return
    const judgement = this.judgeTiming(performance.now())
    if (judgement !== 'miss' && dirOk) {
      this.left.flash = 1
      this.right.flash = 1
    }
    this.keyboardLatched = true
    this.onDualSwipe(judgement, dirOk)
    this.left.swipeDir = null
    this.right.swipeDir = null
    this.pointers.clear()
  }

  private redrawPad(pad: PadSide, pulse: number, telegraph: number, beatFlash: number): void {
    const g = pad.bg
    g.clear()
    const tg = pad.telegraph
    tg.clear()
    const r = pad.radius
    const cmd = this.commandDir
    const inPreview = this.padPhase === 'preview'
    const inHit = this.padPhase === 'hit'
    const highlight =
      inPreview ? 0.15 + pulse * 0.12 + telegraph * 0.25 : inHit ? 0.2 + pulse * 0.12 + beatFlash * 0.5 : 0.1
    g.circle(0, 0, r)
    g.fill({ color: 0x1a3a55, alpha: 0.82 })
    g.circle(0, 0, r)
    g.stroke({ color: inPreview ? 0xffe07a : 0x9fe6ff, width: 3, alpha: 0.35 + highlight })

    if (inPreview && telegraph > 0.02) {
      const inner = r * 0.38
      const outer = r * 0.96
      const ringR = inner + (outer - inner) * (1 - telegraph)
      tg.circle(0, 0, ringR)
      tg.stroke({ color: 0xffd166, width: 5, alpha: 0.35 + telegraph * 0.55 })
      if (telegraph > 0.88) {
        tg.circle(0, 0, inner)
        tg.stroke({ color: 0xffffff, width: 3, alpha: (telegraph - 0.88) / 0.12 })
      }
    }

    if (beatFlash > 0.05 && inHit) {
      g.circle(0, 0, r * 0.88)
      g.stroke({ color: 0xffd166, width: 6, alpha: beatFlash * 0.9 })
      g.circle(0, 0, r * 0.55)
      g.fill({ color: 0xffd166, alpha: beatFlash * 0.12 })
    }
    if (pad.flash > 0) {
      g.circle(0, 0, r)
      g.fill({ color: 0x6ee06e, alpha: pad.flash * 0.35 })
    }
    if (pad.active) {
      g.circle(0, 0, r * 0.92)
      g.stroke({ color: 0xffd166, width: 4, alpha: 0.75 })
    }

    const progressArc = pad.arrow
    progressArc.clear()
    if (inPreview || inHit) {
      const size = 22 + pulse * 6 + (inHit ? beatFlash * 10 : telegraph * 6)
      const angle = cmd === 'left' ? Math.PI : 0
      const alpha = inPreview ? 0.45 + telegraph * 0.5 : 0.75 + beatFlash * 0.25
      this.drawArrowHead(progressArc, 0, -r * 0.15, angle, size, 0xffd166, alpha)
    }
    if (inPreview) {
      pad.hint.text = t('game.lurePadPreviewHint')
    } else if (inHit) {
      pad.hint.text = t('game.lurePadBeatHint')
    } else {
      pad.hint.text = t('game.lureKeyboardHint')
    }
    if (pad === this.left) {
      pad.label.text = t('game.lurePadLeft')
    } else {
      pad.label.text =
        this.progressTarget > 0
          ? `${t('game.lurePadRight')} ${this.progress}/${this.progressTarget}`
          : t('game.lurePadRight')
    }
  }

  private drawArrowHead(
    g: Graphics,
    cx: number,
    cy: number,
    angle: number,
    size: number,
    color: number,
    alpha: number,
  ): void {
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const tipX = cx + cos * size * 0.5
    const tipY = cy + sin * size * 0.5
    const bx = cx - cos * size * 0.35
    const by = cy - sin * size * 0.35
    const wing = size * 0.38
    const lx = bx + (-sin) * wing
    const ly = by + cos * wing
    const rx = bx - (-sin) * wing
    const ry = by - cos * wing
    g.poly([tipX, tipY, lx, ly, rx, ry])
    g.fill({ color, alpha })
  }
}
