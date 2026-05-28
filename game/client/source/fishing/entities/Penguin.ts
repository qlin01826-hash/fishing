import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { FishDef } from '../types'

export type PenguinMood = 'happy' | 'neutral' | 'sad' | 'weak' | 'request'

/**
 * The hungry-penguin commissioner. Hand-drawn from primitives (no sprite
 * sheet needed) with an ASCII face that swaps based on mood:
 *
 *   request : (><)   sad     : (T_T)
 *   neutral : (._.)   weak    : (x x)   happy : (^o^)
 *
 * `setRequest()` shows a speech bubble naming the wished fish — the
 * scene calls this when the commission rolls.
 */
export class Penguin {
  readonly container = new Container()
  private readonly body = new Container()
  private readonly bodyBg = new Graphics()
  private readonly faceText: Text
  private readonly bubble = new Container()
  private readonly bubbleBg = new Graphics()
  private readonly bubbleText: Text

  private mood: PenguinMood = 'request'
  private wobblePhase = Math.random() * Math.PI * 2
  /** Transient message countdown (ms). When >0, message text shadows the
   *  persistent commission request. */
  private bubbleTimer = 0
  /** The active commission, displayed whenever no transient message is up. */
  private persistentRequest: FishDef | null = null

  constructor() {
    this.container.addChild(this.body, this.bubble)
    this.body.addChild(this.bodyBg)

    this.faceText = new Text({
      text: '(><)',
      style: new TextStyle({
        fontSize: 18,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#1f1300',
      }),
    })
    this.faceText.anchor.set(0.5)
    this.body.addChild(this.faceText)

    this.bubbleText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 16,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#211208',
        wordWrap: true,
        wordWrapWidth: 220,
        align: 'left',
      }),
    })
    this.bubble.addChild(this.bubbleBg, this.bubbleText)
    this.bubble.visible = false

    this.drawPenguin()
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y)
  }

  setMood(mood: PenguinMood): void {
    if (this.mood !== mood) {
      this.mood = mood
      this.drawPenguin()
    }
  }

  /** Set the persistent commission request. Shows immediately unless a
   *  transient message is on screen — in which case the request becomes
   *  visible once the message timer expires. */
  showRequest(fish: FishDef): void {
    this.persistentRequest = fish
    if (this.bubbleTimer <= 0) this.applyPersistentRequest()
  }

  /** Show a transient message (timer-based). Persistent request is
   *  restored automatically once the timer drains. */
  showMessage(message: string, mood: PenguinMood = 'neutral', durationMs = 1800): void {
    this.setMood(mood)
    this.bubble.visible = true
    this.bubbleText.text = message
    this.layoutBubble()
    this.bubbleTimer = durationMs
  }

  hideBubble(): void {
    this.bubble.visible = false
    this.bubbleTimer = 0
    this.persistentRequest = null
  }

  /** True when a `showMessage()` is still on its timer. */
  isShowingTransientMessage(): boolean {
    return this.bubbleTimer > 0
  }

  private applyPersistentRequest(): void {
    if (!this.persistentRequest) {
      this.bubble.visible = false
      return
    }
    this.setMood('request')
    this.bubble.visible = true
    this.bubbleText.text = t('penguin.request', {
      wish: t(`fish.${this.persistentRequest.i18nKey}`),
    })
    this.layoutBubble()
  }

  /**
   * @param beatPulse 0..1 — 1 right on a beat, fading toward 0 between
   *                  beats. Drives a beat-synced bob so the penguin
   *                  visibly dances to the soundtrack.
   */
  update(dtSeconds: number, hunger: number, beatPulse = 0): void {
    this.wobblePhase += dtSeconds * (1.5 + hunger * 2)
    const sway = Math.sin(this.wobblePhase) * (1 + hunger * 2)
    // Vertical bob: idle wobble + beat-driven jump.
    const beatBob = beatPulse * (4 + hunger * 3)
    this.body.position.set(sway, Math.sin(this.wobblePhase * 0.9) * 1.5 - beatBob)
    // Slight squash on beat impact so the bob reads as "landing".
    const squash = 1 + beatPulse * 0.08
    this.body.scale.set(squash, 2 - squash)

    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dtSeconds * 1000
      if (this.bubbleTimer <= 0) {
        // Transient expired — bring back the persistent request if any.
        this.applyPersistentRequest()
      }
    }
  }

  private drawPenguin(): void {
    const g = this.bodyBg
    g.clear()
    // Body
    g.ellipse(0, 8, 28, 36)
    g.fill(0x141414)
    // Belly
    g.ellipse(0, 12, 20, 28)
    g.fill(0xf6f6f6)
    // Feet
    g.ellipse(-12, 40, 8, 4)
    g.fill(0xff9425)
    g.ellipse(12, 40, 8, 4)
    g.fill(0xff9425)
    // Beak
    g.poly([0, -6, -5, 0, 5, 0])
    g.fill(0xffa728)
    // Eye whites (slightly different per mood)
    if (this.mood === 'weak' || this.mood === 'sad') {
      g.rect(-9, -18, 4, 2)
      g.fill(0x1a0500)
      g.rect(5, -18, 4, 2)
      g.fill(0x1a0500)
    } else {
      g.circle(-6, -16, 3)
      g.fill(0xffffff)
      g.circle(6, -16, 3)
      g.fill(0xffffff)
      g.circle(-6, -16, 1.4)
      g.fill(0x1a0500)
      g.circle(6, -16, 1.4)
      g.fill(0x1a0500)
    }
    // Update face text on top of body
    this.faceText.text = faceFor(this.mood)
    this.faceText.position.set(0, 24)
  }

  private layoutBubble(): void {
    const padX = 12
    const padY = 8
    const w = this.bubbleText.width + padX * 2
    const h = this.bubbleText.height + padY * 2
    this.bubbleBg.clear()
    this.bubbleBg.roundRect(0, 0, w, h, 12)
    this.bubbleBg.fill({ color: 0xfff7e1, alpha: 0.96 })
    this.bubbleBg.stroke({ color: 0x4a2b00, width: 2, alpha: 0.7 })
    // Pointer tail pointing DOWN at the penguin (bottom of bubble).
    // The penguin now sits on the boat deck so a side-pointing bubble
    // would clip the mast / cabin — overhead with a down-pointer reads
    // cleanly no matter where on the boat the penguin is parked.
    this.bubbleBg.poly([w / 2 - 6, h, w / 2 + 6, h, w / 2, h + 12])
    this.bubbleBg.fill({ color: 0xfff7e1, alpha: 0.96 })
    this.bubbleText.position.set(padX, padY)
    // Bubble centred horizontally over the penguin, ~50px above the head.
    this.bubble.position.set(-w / 2, -h - 50)
  }
}

function faceFor(mood: PenguinMood): string {
  switch (mood) {
    case 'happy':
      return '(^o^)'
    case 'sad':
      return '(T_T)'
    case 'weak':
      return '(x x)'
    case 'request':
      return '(><)'
    case 'neutral':
    default:
      return '(._.)'
  }
}
