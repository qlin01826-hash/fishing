import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { Judgement, JudgeEvent } from '../battle/ArcaeaJudge'

// --------------- Floating judgement text ---------------

interface FloatingText {
  text: Text
  life: number
}

const FLOAT_DURATION = 0.45
const FLOAT_RISE_PX = 32

const JUDGE_STYLES: Record<Judgement, { fill: string; label: string }> = {
  PURE: { fill: '#8ef4ff', label: 'PURE' },
  FAR: { fill: '#b8c8d8', label: 'FAR' },
  LOST: { fill: '#ff5a5a', label: 'LOST' },
}

// --------------- Combo counter ---------------

const COMBO_MIN_SHOW = 2

/**
 * Arcaea-style in-game HUD: floating judgement text per hit, a pulsing
 * combo counter, and lane-flash overlays.
 *
 * All coordinates are in screen space; the owner (BattleState /
 * FishingScene) feeds screen-space positions from Transform3D projections.
 */
export class ArcaeaHud {
  readonly container = new Container()

  private readonly floatLayer = new Container()
  /** Additive layer for milestone star-burst sparkles around the combo. */
  private readonly sparkleFx = new Graphics()
  private readonly comboText: Text
  private readonly comboLabel: Text
  /** Single pulsing label for continuous sky-arc PURE ticks. */
  private readonly arcLabel: Text
  private arcLabelLife = 0
  private floats: FloatingText[] = []
  private comboPulse = 0
  private sparkles: { x: number; y: number; life: number; max: number; rot: number }[] = []
  private lastComboVal = 0

  // Screen-space fallback centre for judgement text when screen coords
  // aren't supplied by the event.
  private judgeCx = 400
  private judgeCy = 300

  constructor() {
    this.comboText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 38,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '900',
        fill: '#ffffff',
        stroke: { color: 0x000000, width: 4 },
      }),
    })
    this.comboText.anchor.set(0.5, 0.5)
    this.comboText.alpha = 0

    this.comboLabel = new Text({
      text: 'COMBO',
      style: new TextStyle({
        fontSize: 12,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill: '#a0e0ff',
        stroke: { color: 0x000000, width: 2 },
      }),
    })
    this.comboLabel.anchor.set(0.5, 0.5)
    this.comboLabel.alpha = 0

    this.arcLabel = new Text({
      text: 'PURE',
      style: new TextStyle({
        fontSize: 24,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '900',
        fill: '#8ef4ff',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.arcLabel.anchor.set(0.5, 0.5)
    this.arcLabel.alpha = 0

    this.sparkleFx.blendMode = 'add'
    this.container.addChild(
      this.floatLayer,
      this.sparkleFx,
      this.arcLabel,
      this.comboText,
      this.comboLabel,
    )
  }

  setLayout(width: number, height: number): void {
    this.judgeCx = width * 0.5
    this.judgeCy = height * 0.55
    this.comboText.position.set(width * 0.5, height * 0.18)
    this.comboLabel.position.set(width * 0.5, height * 0.18 + 26)
  }

  /** Feed a judge event from ArcaeaJudge. */
  onJudge(ev: JudgeEvent): void {
    const style = JUDGE_STYLES[ev.judgement]
    const x = ev.screenX >= 0 ? ev.screenX : this.judgeCx
    const y = ev.screenY >= 0 ? ev.screenY : this.judgeCy
    // Sky ticks fire every 100ms while a finger rides the arc. Rather than
    // stacking a new text each tick, refresh a single persistent PURE label
    // at the arc's screen point so it "pulses" without flooding the layer.
    if (ev.type === 'sky-tick' && ev.judgement === 'PURE') {
      // Sky-stream ticks use the energised neon-magenta to match the
      // "high-voltage" arc material while riding.
      this.refreshArcLabel('PURE', '#ff66cc', x, y)
      return
    }
    this.spawnFloat(style.label, style.fill, x, y)
  }

  /** Update combo display. Call with the current combo value each frame. */
  setCombo(combo: number): void {
    // Milestone star-burst every 50 combo (50, 100, 150 …).
    if (combo >= 50 && Math.floor(combo / 50) > Math.floor(this.lastComboVal / 50)) {
      this.spawnComboSparkle()
    }
    this.lastComboVal = combo

    if (combo >= COMBO_MIN_SHOW) {
      this.comboText.text = `${combo}`
      this.comboText.alpha = 1
      this.comboLabel.alpha = 0.75
    } else {
      this.comboText.alpha = 0
      this.comboLabel.alpha = 0
    }
  }

  private spawnComboSparkle(): void {
    const cx = this.comboText.x
    const cy = this.comboText.y
    for (let i = 0; i < 5; i++) {
      this.sparkles.push({
        x: cx + (Math.random() - 0.5) * 70,
        y: cy + (Math.random() - 0.5) * 36,
        life: 0.5,
        max: 0.5,
        rot: Math.random() * Math.PI,
      })
    }
    // A strong heartbeat to celebrate the milestone.
    this.comboPulse = 1.4
  }

  /** Trigger the scale-pulse on combo increment. */
  pulseCombo(): void {
    this.comboPulse = 1
  }

  /** Refresh the single pulsing arc-tick label at the arc's screen point. */
  private refreshArcLabel(label: string, fill: string, x: number, y: number): void {
    this.arcLabel.text = label
    this.arcLabel.style.fill = fill
    this.arcLabel.position.set(x, y - 24)
    this.arcLabel.alpha = 1
    this.arcLabel.scale.set(1.25)
    this.arcLabelLife = 0.18
  }

  update(dtSec: number): void {
    // Float text
    for (const f of this.floats) {
      f.life -= dtSec
      const t = 1 - f.life / FLOAT_DURATION
      f.text.position.y -= FLOAT_RISE_PX * dtSec / FLOAT_DURATION
      f.text.alpha = Math.max(0, 1 - t)
      f.text.scale.set(1 + (1 - t) * 0.2)
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      if (this.floats[i].life <= 0) {
        this.floatLayer.removeChild(this.floats[i].text)
        this.floats.splice(i, 1)
      }
    }

    // Combo pulse — elastic heartbeat (hit pop ≈ 1.3, snaps back to 1.0).
    if (this.comboPulse > 0) {
      this.comboPulse = Math.max(0, this.comboPulse - dtSec * 6)
    }
    const s = 1 + this.comboPulse * 0.3
    this.comboText.scale.set(s)
    this.comboLabel.scale.set(1 + this.comboPulse * 0.1)

    // Milestone star-burst sparkles.
    this.updateSparkles(dtSec)

    // Pulsing arc-tick label: shrinks back toward 1.0 and fades unless the
    // next tick refreshes it (i.e. the finger is still riding the arc).
    if (this.arcLabelLife > 0) {
      this.arcLabelLife -= dtSec
      const k = Math.max(0, this.arcLabelLife / 0.18)
      this.arcLabel.alpha = 0.4 + k * 0.6
      this.arcLabel.scale.set(1 + k * 0.25)
    } else {
      this.arcLabel.alpha = Math.max(0, this.arcLabel.alpha - dtSec * 4)
    }
  }

  private updateSparkles(dtSec: number): void {
    const g = this.sparkleFx
    g.clear()
    for (let i = this.sparkles.length - 1; i >= 0; i--) {
      const sp = this.sparkles[i]
      sp.life -= dtSec
      if (sp.life <= 0) {
        this.sparkles.splice(i, 1)
        continue
      }
      const t = 1 - sp.life / sp.max
      const len = 6 + t * 22
      const alpha = (1 - t) * 0.9
      // Four-point cross star + 45° diagonal, blue-white twinkle.
      for (let k = 0; k < 4; k++) {
        const a = sp.rot + (k / 4) * Math.PI * 2
        const long = k % 2 === 0 ? len : len * 0.55
        g.moveTo(sp.x - Math.cos(a) * long, sp.y - Math.sin(a) * long)
        g.lineTo(sp.x + Math.cos(a) * long, sp.y + Math.sin(a) * long)
      }
      g.stroke({ color: 0x9fd4ff, width: 2, alpha, cap: 'round' })
      g.circle(sp.x, sp.y, 2.5 * (1 - t))
      g.fill({ color: 0xffffff, alpha })
    }
  }

  private spawnFloat(label: string, fill: string, x: number, y: number): void {
    const t = new Text({
      text: label,
      style: new TextStyle({
        fontSize: 22,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill,
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    t.anchor.set(0.5, 0.5)
    t.position.set(x, y)
    this.floatLayer.addChild(t)
    this.floats.push({ text: t, life: FLOAT_DURATION })
  }
}
