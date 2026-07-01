import { Circle, Container, FederatedPointerEvent, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { BeatClock } from '../systems/BeatClock'

/** Per-tap accuracy buckets, used by the visual layer and the scoring math. */
export type TapJudgement = 'perfect' | 'good' | 'miss'

/** Wave-breaking vs. cast-hook vs. tug-of-war lure vs. fish fight. */
export type PullPanelMode = 'wave' | 'cast' | 'tugFish' | 'tugPull' | 'battle'

/**
 * Bottom-left rhythm panel used during SailingState and BattleState.
 *
 * It's the "破浪" (wave-breaking) layer:
 *   - tap in time with the downbeat → the hull rides the crest
 *   - mistimed taps shove the boat off course
 *   - after N waves, the panel briefly becomes "甩钩" for a one-beat
 *     cast window (SailingState only)
 */
export class PullPanel {
  readonly container = new Container()

  private readonly bg = new Graphics()
  private readonly beatRing = new Graphics()
  private readonly tapFillArc = new Graphics()
  private readonly pressFillArc = new Graphics()
  private readonly rippleLayer = new Graphics()
  private readonly struggleOutline = new Graphics()
  private readonly label: Text
  private readonly hint: Text
  private readonly judgement: Text
  private readonly combo: Text

  /** 0..1 — current short-lived impulse from tapping. */
  tapPower = 0
  /** 0..1 — current sustained pressure from holding. */
  pressPower = 0

  /** Multiplier applied to tap impulses while the combo is alive (>=1). */
  comboMultiplier = 1
  /** Streak of Perfect-or-Good taps in a row. Resets on miss. */
  private comboCount = 0
  private chaseHudMode = false
  private judgementTimer = 0

  /**
   * Called every time the player taps, with the resulting judgement.
   * BattleState wires this to (1) forward to NoteLane and (2) update
   * the tension tracker. Defaults to a no-op so the panel works
   * standalone in unit tests.
   */
  onJudgement: (judgement: TapJudgement, nowMs: number, beatPhase: number, dir?: number) => void =
    () => {}

  private pressing = false
  private pressStart = 0

  // --- Directional flick (battle "follow the fish" steering) ---
  /**
   * In battle mode a tap can carry a horizontal direction. We anchor the
   * rhythm timing to the press instant but resolve the direction a few ms
   * later: a quick left/right swipe reads as a steer (-1 / +1), a still
   * tap stays a centre tap (0). This lets the diver chase the weaving fish
   * while keeping the on-beat timing precise.
   */
  private flickPending = false
  private flickDownMs = 0
  private flickDownX = 0
  private flickResolveHandle: number | null = null
  /** Pixels of horizontal travel that count as a directional swipe. */
  private readonly flickThresholdPx = 26
  /** How long to wait for a swipe before resolving as a centre tap. */
  private readonly flickResolveMs = 95
  /** Recent tap timestamps for frequency tracking. */
  private recentTaps: number[] = []
  private readonly tapPeakHz = 7

  private outerRadius = 90
  private innerRadius = 46

  /** Visual "fish is struggling" state — paints the rim red and shakes. */
  private struggling = false
  /** Decays the post-tap ripple animation (0..1). */
  private ripples: Array<{ t: number; color: number }> = []
  /** Decays the post-miss red border flash (0..1). */
  private missFlash = 0

  private beatClock: BeatClock | null = null
  private mode: PullPanelMode = 'wave'
  /** Waves cleared since last cast window (shown as a small arc). */
  private waveProgress = 0
  private waveProgressTarget = 4

  /** Radius of the perfect-timing window in ms either side of a beat. */
  private readonly perfectWindowMs = 90
  /** Radius of the good-timing window in ms either side of a beat. */
  private readonly goodWindowMs = 200

  constructor() {
    this.label = new Text({
      text: t('game.waveButton'),
      style: new TextStyle({
        fontSize: 22,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#fff7e1',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.label.anchor.set(0.5, 0.5)
    this.hint = new Text({
      text: t('game.waveHint'),
      style: new TextStyle({
        fontSize: 11,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#ffefb0',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.hint.anchor.set(0.5, 0.5)
    this.judgement = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 22,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill: '#ffd166',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.judgement.anchor.set(0.5, 0.5)
    this.judgement.alpha = 0
    this.combo = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 16,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill: '#ffe39a',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.combo.anchor.set(0.5, 0.5)
    this.combo.alpha = 0

    this.container.addChild(
      this.bg,
      this.pressFillArc,
      this.tapFillArc,
      this.beatRing,
      this.rippleLayer,
      this.struggleOutline,
      this.label,
      this.hint,
      this.judgement,
      this.combo,
    )
    this.bg.eventMode = 'static'
    this.bg.cursor = 'pointer'
    this.bg.on('pointerdown', this.handleDown, this)
    this.bg.on('globalpointermove', this.handleMove, this)
    this.bg.on('pointerup', this.handleUp, this)
    this.bg.on('pointerupoutside', this.handleUp, this)
    this.bg.on('pointercancel', this.handleUp, this)
  }

  getComboCount(): number {
    return this.comboCount
  }

  /** During 3D chase, combo moves to the sky HUD — hide the panel readout. */
  setChaseHudMode(on: boolean): void {
    this.chaseHudMode = on
    if (on) this.combo.alpha = 0
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
  }

  setMode(mode: PullPanelMode): void {
    this.mode = mode
    switch (mode) {
      case 'cast':
        this.label.text = t('game.castHookButton')
        this.hint.text = t('game.castHookHint')
        break
      case 'tugFish':
        this.label.text = t('game.tugFishWait')
        this.hint.text = t('game.tugFishHint')
        break
      case 'tugPull':
        this.label.text = t('game.tugPullButton')
        this.hint.text = t('game.tugPullHint')
        break
      case 'battle':
        this.label.text = t('game.pullButton')
        this.hint.text = t('game.battlePullHint')
        break
      default:
        this.label.text = t('game.waveButton')
        this.hint.text = t('game.waveHint')
    }
    this.bg.eventMode = mode === 'tugFish' ? 'none' : 'static'
    this.bg.cursor = mode === 'tugFish' ? 'default' : 'pointer'
  }

  getMode(): PullPanelMode {
    return this.mode
  }

  setWaveProgress(cleared: number, target: number): void {
    this.waveProgress = cleared
    this.waveProgressTarget = Math.max(1, target)
  }

  /**
   * Place the panel with its CENTER at (cx, cy). `outerRadius` is the
   * full tap-zone radius; the inner target is sized off it.
   */
  setPosition(cx: number, cy: number, outerRadius = 90): void {
    this.outerRadius = outerRadius
    this.innerRadius = Math.max(28, outerRadius * 0.5)
    this.container.position.set(cx, cy)
    // Single hit-area allocation (re-using a Circle on every draw would
    // churn GC for no gain).
    this.bg.hitArea = new Circle(0, 0, outerRadius)
    this.draw()
  }

  /** True if a global stage-space point falls inside the circular hit area. */
  containsGlobalPoint(globalX: number, globalY: number): boolean {
    const dx = globalX - this.container.position.x
    const dy = globalY - this.container.position.y
    return dx * dx + dy * dy <= this.outerRadius * this.outerRadius
  }

  /** Per-frame decay + draw. */
  update(dtSeconds: number, nowMs: number): void {
    this.tapPower = Math.max(0, this.tapPower - dtSeconds * 1.6)
    if (this.pressing) {
      const held = (nowMs - this.pressStart) / 1000
      const target = Math.min(1, 0.35 + held * 0.6)
      this.pressPower += (target - this.pressPower) * Math.min(1, dtSeconds * 4)
    } else {
      this.pressPower *= Math.exp(-dtSeconds * 3)
    }
    const cutoff = nowMs - 1200
    while (this.recentTaps.length > 0 && this.recentTaps[0] < cutoff) {
      this.recentTaps.shift()
    }
    // Combo decays naturally if the player goes silent for too long
    if (this.comboCount > 0 && this.recentTaps.length === 0) {
      this.comboCount = 0
      this.comboMultiplier = 1
    }
    if (this.judgementTimer > 0) {
      this.judgementTimer -= dtSeconds
    }
    // Advance ripples and miss flash.
    for (const r of this.ripples) r.t -= dtSeconds * 2.2
    this.ripples = this.ripples.filter((r) => r.t > 0)
    this.missFlash = Math.max(0, this.missFlash - dtSeconds * 2.5)
    this.draw(nowMs)
  }

  /** Toggle the "fish is struggling" visual treatment from BattleState. */
  setStruggling(struggling: boolean): void {
    this.struggling = struggling
  }

  /** Reset state (when leaving battle). */
  reset(): void {
    this.tapPower = 0
    this.pressPower = 0
    this.pressing = false
    this.flickPending = false
    if (this.flickResolveHandle !== null) {
      window.clearTimeout(this.flickResolveHandle)
      this.flickResolveHandle = null
    }
    this.recentTaps.length = 0
    this.comboCount = 0
    this.comboMultiplier = 1
    this.judgementTimer = 0
    this.struggling = false
    this.ripples.length = 0
    this.missFlash = 0
    this.mode = 'wave'
    this.waveProgress = 0
  }

  /** Programmatic tap (SailingState cast window uses this). */
  externalTap(): TapJudgement {
    return this.triggerTapInternal()
  }

  private handleDown(event: FederatedPointerEvent): void {
    // Battle taps carry a steer direction resolved a few ms later; every
    // other mode fires immediately so the rhythm stays tight.
    if (this.mode === 'battle') {
      this.beginFlick(event.global.x)
    } else {
      this.triggerTapInternal()
    }
  }

  private handleMove(event: FederatedPointerEvent): void {
    if (!this.flickPending) return
    const dx = event.global.x - this.flickDownX
    if (Math.abs(dx) >= this.flickThresholdPx) {
      this.resolveFlick(dx > 0 ? 1 : -1)
    }
  }

  private handleUp(_event: FederatedPointerEvent): void {
    if (this.flickPending) this.resolveFlick(0)
    this.releaseHold()
  }

  /** Start a pending battle flick, anchoring timing to the press instant. */
  private beginFlick(globalX: number): void {
    this.flickPending = true
    this.flickDownMs = performance.now()
    this.flickDownX = globalX
    this.pressing = true
    this.pressStart = this.flickDownMs
    if (this.flickResolveHandle !== null) window.clearTimeout(this.flickResolveHandle)
    this.flickResolveHandle = window.setTimeout(() => this.resolveFlick(0), this.flickResolveMs)
  }

  /** Emit the pending flick as a tap with the resolved direction. */
  private resolveFlick(dir: number): void {
    if (!this.flickPending) return
    this.flickPending = false
    if (this.flickResolveHandle !== null) {
      window.clearTimeout(this.flickResolveHandle)
      this.flickResolveHandle = null
    }
    this.triggerTapInternal(dir, this.flickDownMs)
  }

  /**
   * Keyboard equivalent of a finger tap. Wired to the SPACE key by
   * FishingScene so PC players have a one-handed rhythm interface.
   */
  keyboardTap(dir = 0): void {
    this.triggerTapInternal(dir)
  }

  /** Keyboard equivalent of finger lift (Space released). */
  keyboardRelease(): void {
    this.releaseHold()
  }

  /**
   * Single source of truth for "the player just initiated a tap, no
   * matter the input device". Used by both Pixi pointer events and
   * keyboard events.
   */
  private triggerTapInternal(dir = 0, atMs = performance.now()): TapJudgement {
    const now = atMs
    const judgement = this.judgeTap(now)
    const beatPhase = this.beatClock?.started ? this.beatClock.phase(now) : 0.5
    const recentHz =
      this.recentTaps.length >= 2
        ? (this.recentTaps.length - 1) /
          Math.max(0.001, (now - this.recentTaps[0]) / 1000)
        : 0
    const overPeak = recentHz >= this.tapPeakHz
    const accuracyMul =
      judgement === 'perfect' ? 1.6 : judgement === 'good' ? 1.0 : 0.4
    const base = overPeak ? 0.08 : 0.32
    this.tapPower = Math.min(1, this.tapPower + base * accuracyMul * this.comboMultiplier)
    this.recentTaps.push(now)
    this.applyJudgement(judgement)
    const color =
      judgement === 'perfect' ? 0x9fe6ff : judgement === 'good' ? 0x7ec8e3 : 0xff6b6b
    this.ripples.push({ t: 1, color })
    if (judgement === 'miss') this.missFlash = 1
    this.pressing = true
    this.pressStart = now
    this.onJudgement(judgement, now, beatPhase, dir)
    return judgement
  }

  private releaseHold(): void {
    this.pressing = false
  }

  private judgeTap(nowMs: number): TapJudgement {
    if (!this.beatClock || !this.beatClock.started) {
      // No beat reference yet (audio still locked) — treat as "good"
      // so the player still gets reasonable pull-power on first taps.
      return 'good'
    }
    const offset = Math.abs(this.beatClock.msFromNearestBeat(nowMs))
    if (offset <= this.perfectWindowMs) return 'perfect'
    if (offset <= this.goodWindowMs) return 'good'
    return 'miss'
  }

  private applyJudgement(judgement: TapJudgement): void {
    this.judgementTimer = 0.5
    if (judgement === 'perfect') {
      this.comboCount += 1
    } else if (judgement === 'good') {
      // Good preserves the combo but doesn't grow it.
    } else {
      this.comboCount = 0
    }
    // Combo multiplier saturates at 1.5x after 8 perfect taps.
    this.comboMultiplier = 1 + Math.min(0.5, this.comboCount * 0.06)
    this.judgement.text =
      judgement === 'perfect'
        ? t('game.wavePerfect')
        : judgement === 'good'
          ? t('game.waveGood')
          : t('game.waveMiss')
    this.judgement.style.fill =
      judgement === 'perfect' ? '#9fe6ff' : judgement === 'good' ? '#7ec8e3' : '#ff6b6b'
  }

  private draw(nowMs = performance.now()): void {
    const outerR = this.outerRadius
    const innerR = this.innerRadius

    let flash = 0
    let beatPhase = 0.5
    if (this.beatClock?.started) {
      beatPhase = this.beatClock.phase(nowMs)
      flash = beatPhase < 0.18 ? 1 - beatPhase / 0.18 : 0
    }

    const bg = this.bg
    bg.clear()
    bg.circle(0, 0, outerR)
    const castMode = this.mode === 'cast'
    const tugFish = this.mode === 'tugFish'
    const tugPull = this.mode === 'tugPull'
    const battleMode = this.mode === 'battle'
    const bgColor = this.struggling
      ? 0x4a1414
      : castMode
        ? 0x1a2838
        : tugFish
          ? 0x0a1420
          : battleMode
            ? 0x102038
            : 0x081827
    bg.fill({ color: bgColor, alpha: tugFish ? 0.55 : 0.78 })
    const rimColor = castMode
      ? 0xffe07a
      : tugPull || battleMode
        ? 0xffd166
        : tugFish
          ? 0x4a6080
          : this.struggling
            ? 0xff6b6b
            : 0x9fe6ff
    bg.stroke({ color: rimColor, width: 2, alpha: 0.85 })
    bg.circle(0, 0, innerR)
    bg.fill({
      color: castMode ? 0xffe07a : 0x9fe6ff,
      alpha: 0.12 + 0.55 * flash,
    })
    bg.stroke({ color: rimColor, width: 3, alpha: 0.7 + 0.3 * flash })

    const ring = this.beatRing
    ring.clear()
    if (this.beatClock?.started && !castMode && !tugFish && !tugPull && !battleMode) {
      // Incoming wave crest — horizontal arc rises toward the hull icon.
      const waveY = innerR * 0.35 - beatPhase * innerR * 1.1
      ring.moveTo(-outerR * 0.75, waveY)
      for (let i = 0; i <= 12; i += 1) {
        const x = -outerR * 0.75 + (outerR * 1.5 * i) / 12
        const y = waveY + Math.sin((i / 12) * Math.PI * 2 + beatPhase * 6) * 4
        ring.lineTo(x, y)
      }
      ring.stroke({ color: 0x9fe6ff, width: 4, alpha: 0.35 + 0.5 * (1 - beatPhase) })
    } else if (this.beatClock?.started && (castMode || tugPull || battleMode)) {
      const r = innerR + (outerR * 0.95 - innerR) * (1 - beatPhase)
      ring.circle(0, 0, r)
      const ringColor = castMode ? 0xffe07a : 0xffd166
      ring.stroke({ color: ringColor, width: 5, alpha: 0.5 + 0.45 * (1 - beatPhase) })
    } else if (tugFish && this.beatClock?.started) {
      const drop = innerR * beatPhase
      ring.moveTo(-outerR * 0.5, -drop)
      ring.lineTo(0, innerR * 0.4 - drop)
      ring.lineTo(outerR * 0.5, -drop)
      ring.stroke({ color: 0x4a6080, width: 4, alpha: 0.5 })
    }

    if (!castMode && !tugFish && !tugPull && !battleMode && this.waveProgressTarget > 0) {
      const prog = Math.min(1, this.waveProgress / this.waveProgressTarget)
      if (prog > 0.01) {
        ring.arc(0, 0, outerR - 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog)
        ring.stroke({ color: 0xffe07a, width: 3, alpha: 0.65 })
      }
    }

    // Tap power: gold arc on the top half of the rim.
    const tapArc = this.tapFillArc
    tapArc.clear()
    if (this.tapPower > 0.01) {
      const span = Math.PI * this.tapPower
      tapArc.arc(0, 0, outerR - 6, -Math.PI / 2 - span / 2, -Math.PI / 2 + span / 2)
      tapArc.stroke({ color: 0xffd166, width: 5, alpha: 0.95 })
    }
    // Press power: blue arc on the bottom half of the rim.
    const pressArc = this.pressFillArc
    pressArc.clear()
    if (this.pressPower > 0.01) {
      const span = Math.PI * this.pressPower
      pressArc.arc(0, 0, outerR - 6, Math.PI / 2 - span / 2, Math.PI / 2 + span / 2)
      pressArc.stroke({ color: 0x4cb1ff, width: 5, alpha: 0.95 })
    }

    this.label.position.set(0, -10)
    this.hint.position.set(0, 16)

    // Judgement floats up and fades.
    if (this.judgementTimer > 0) {
      const t01 = 1 - this.judgementTimer / 0.5
      this.judgement.alpha = 1 - t01
      this.judgement.position.set(0, -outerR - 16 - t01 * 18)
      this.judgement.scale.set(1 + (1 - t01) * 0.25)
    } else {
      this.judgement.alpha = 0
    }
    // Combo readout (hidden during 3D chase — rendered on sky HUD instead)
    if (!this.chaseHudMode && this.comboCount >= 2) {
      this.combo.text = `x${this.comboCount}  combo`
      this.combo.alpha = 0.92
      this.combo.position.set(0, outerR + 18)
    } else {
      this.combo.alpha = 0
    }

    // Tap ripples: expanding rings from the centre, coloured by judgement.
    const rl = this.rippleLayer
    rl.clear()
    for (const r of this.ripples) {
      const t01 = 1 - r.t // 0..1 expansion progress
      const radius = innerR + t01 * (outerR + 30 - innerR)
      rl.circle(0, 0, radius)
      rl.stroke({ color: r.color, width: 3, alpha: Math.max(0, r.t) * 0.85 })
    }

    // Struggle outline: pulsing red ring around the rim, plus a one-shot
    // red flash whenever the most recent tap was a miss.
    const so = this.struggleOutline
    so.clear()
    const strugglePulse = this.struggling
      ? 0.6 + 0.4 * Math.sin(nowMs * 0.012)
      : 0
    if (strugglePulse > 0) {
      so.circle(0, 0, outerR + 6)
      so.stroke({ color: 0xff6b6b, width: 3, alpha: strugglePulse * 0.75 })
    }
    if (this.missFlash > 0) {
      so.circle(0, 0, outerR + 2)
      so.stroke({ color: 0xff6b6b, width: 5, alpha: this.missFlash })
    }
  }
}
