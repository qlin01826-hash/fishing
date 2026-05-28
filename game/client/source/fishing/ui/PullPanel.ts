import { Circle, Container, FederatedPointerEvent, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { BeatClock } from '../systems/BeatClock'

/** Per-tap accuracy buckets, used by the visual layer and the scoring math. */
export type TapJudgement = 'perfect' | 'good' | 'miss'

/**
 * Bottom-left rhythm panel used during BattleState.
 *
 * It's the "底拍" (base-beat) layer of the music game:
 *   - tap in time with the {@link BeatClock} → big short-lived impulse
 *   - hold → steady Stardew-style pressure
 *   - perfect taps build a combo that multiplies the impulse, so the
 *     player feels rewarded for syncing to the drum loop.
 *
 * Visuals (matches the user's reference sketch):
 *   - large circular hit zone in the bottom-left of the screen
 *   - a shrinking outer ring tells the player when the next beat lands
 *     (Osu!-style: ring meets the inner target at beat impact)
 *   - the inner target flashes briefly on each beat for extra clarity
 *   - last judgement ("PERFECT!" / "GOOD" / "MISS") floats up and fades
 *   - combo counter sits above the panel
 *
 * The panel owns its hit testing — BattleState delegates pointer-down
 * geometry to {@link containsLocalPoint} so we don't duplicate the
 * circular-vs-rectangular distinction.
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
  private judgementTimer = 0

  /**
   * Called every time the player taps, with the resulting judgement.
   * BattleState wires this to (1) forward to NoteLane and (2) update
   * the tension tracker. Defaults to a no-op so the panel works
   * standalone in unit tests.
   */
  onJudgement: (judgement: TapJudgement, nowMs: number) => void = () => {}

  private pressing = false
  private pressStart = 0
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

  /** Radius of the perfect-timing window in ms either side of a beat. */
  private readonly perfectWindowMs = 90
  /** Radius of the good-timing window in ms either side of a beat. */
  private readonly goodWindowMs = 200

  constructor() {
    this.label = new Text({
      text: t('game.pullButton'),
      style: new TextStyle({
        fontSize: 22,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#fff7e1',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.label.anchor.set(0.5, 0.5)
    this.hint = new Text({
      text: 'TAP · SPACE',
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
    this.bg.on('pointerup', this.handleUp, this)
    this.bg.on('pointerupoutside', this.handleUp, this)
    this.bg.on('pointercancel', this.handleUp, this)
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
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
    this.recentTaps.length = 0
    this.comboCount = 0
    this.comboMultiplier = 1
    this.judgementTimer = 0
    this.struggling = false
    this.ripples.length = 0
    this.missFlash = 0
  }

  private handleDown(_event: FederatedPointerEvent): void {
    this.triggerTap()
  }

  private handleUp(_event: FederatedPointerEvent): void {
    this.releaseHold()
  }

  /**
   * Keyboard equivalent of a finger tap. Wired to the SPACE key by
   * FishingScene so PC players have a one-handed rhythm interface.
   */
  keyboardTap(): void {
    this.triggerTap()
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
  private triggerTap(): void {
    const now = performance.now()
    const judgement = this.judgeTap(now)
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
    // Visual feedback: every tap emits a ripple coloured by judgement so
    // the player gets immediate, kinetic confirmation of timing.
    const color =
      judgement === 'perfect' ? 0xffd166 : judgement === 'good' ? 0x9fe6ff : 0xff6b6b
    this.ripples.push({ t: 1, color })
    if (judgement === 'miss') this.missFlash = 1
    this.pressing = true
    this.pressStart = now
    this.onJudgement(judgement, now)
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
      judgement === 'perfect' ? 'PERFECT!' : judgement === 'good' ? 'GOOD' : 'MISS'
    this.judgement.style.fill =
      judgement === 'perfect' ? '#ffd166' : judgement === 'good' ? '#9fe6ff' : '#ff6b6b'
  }

  private draw(nowMs = performance.now()): void {
    const outerR = this.outerRadius
    const innerR = this.innerRadius

    // Beat-driven flash brightness for the inner target.
    let flash = 0
    let beatPhase = 0.5
    if (this.beatClock?.started) {
      beatPhase = this.beatClock.phase(nowMs)
      // Brief bright pulse right after each beat (first 18% of beat).
      flash = beatPhase < 0.18 ? 1 - beatPhase / 0.18 : 0
    }

    const bg = this.bg
    bg.clear()
    // Outer disc (the hit zone). Background tint shifts toward red when
    // the fish is actively struggling, which (combined with the outline
    // pulse) reads at a glance.
    bg.circle(0, 0, outerR)
    const bgColor = this.struggling ? 0x4a1414 : 0x081827
    bg.fill({ color: bgColor, alpha: 0.78 })
    const rimColor = this.struggling ? 0xff6b6b : 0xffefb0
    bg.stroke({ color: rimColor, width: 2, alpha: 0.85 })
    // Inner target (the "click here" hot spot)
    bg.circle(0, 0, innerR)
    bg.fill({ color: 0xffe39a, alpha: 0.12 + 0.55 * flash })
    bg.stroke({ color: 0xffd166, width: 3, alpha: 0.7 + 0.3 * flash })

    // Osu!-style shrinking beat ring: starts at outer rim, contracts
    // toward the inner target as the next beat approaches.
    const ring = this.beatRing
    ring.clear()
    if (this.beatClock?.started) {
      const r = innerR + (outerR * 0.95 - innerR) * (1 - beatPhase)
      ring.circle(0, 0, r)
      ring.stroke({ color: 0xffd166, width: 5, alpha: 0.35 + 0.5 * (1 - beatPhase) })
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
    // Combo readout (only when the player is actually building one)
    if (this.comboCount >= 2) {
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
