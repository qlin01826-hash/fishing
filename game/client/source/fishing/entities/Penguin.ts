import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import type { FishDef } from '../types'

export type PenguinMood =
  | 'happy'
  | 'neutral'
  | 'sad'
  | 'weak'
  | 'request'
  | 'excited'
  | 'surprised'
  | 'love'
  | 'wink'
  | 'proud'
  | 'worried'

/** One short-lived mood emote floating around the penguin's head. */
interface EmoteParticle {
  kind: 'tear' | 'sweat' | 'heart' | 'star' | 'note' | 'sparkle'
  x: number
  y: number
  vx: number
  vy: number
  /** 1 → 0 lifetime. */
  t: number
  size: number
  /** Per-particle rotation seed. */
  spin: number
}

/**
 * The hungry-penguin commissioner. Hand-drawn from primitives, with a
 * rich, fully-vector face that swaps eye shape / brow / cheeks / mouth
 * per mood and emits matching particles (tears, hearts, sparkles, …).
 *
 * Supported moods:
 *
 *   request   – eager wide eyes + cheeks       (default after a commission rolls)
 *   neutral   – plain dot eyes
 *   happy     – ^_^ closed-arc eyes + cheeks + ♪ notes
 *   sad       – droopy U eyes + tear drops
 *   weak      – X X eyes
 *   excited   – ★ star eyes + sparkle particles
 *   surprised – huge round eyes + open beak
 *   love      – ♥ heart eyes + floating hearts
 *   wink      – one arc + one dot
 *   proud     – half-closed smug lids
 *   worried   – tiny dots + slanted brows + sweat drop
 *
 * Random blinks fire every few seconds for life. The flippers animate
 * differently per mood (raised for cheer, drooped for weak, etc.) and
 * gently flap on the music beat.
 */
export class Penguin {
  readonly container = new Container()
  private readonly body = new Container()
  private readonly bodyBg = new Graphics()
  /**
   * Flipper "arms" — drawn INSIDE the body container so they squash
   * with the bob. Pose driven by mood + a small beat flap.
   */
  private readonly flippers = new Graphics()
  /** Hand-drawn face (eyes/brows/mouth/cheeks). Inside body so it bobs. */
  private readonly face = new Graphics()
  /**
   * Mood emote particles (tears, hearts, sparkles, ♪ notes…). NOT
   * inside the body container so the squash/flip doesn't deform them
   * — they're meant to read as rising 2D icons floating around the
   * penguin's head.
   */
  private readonly emoteGraphics = new Graphics()
  /** Kept for backwards-compat but rendered invisible — we now draw a
   *  real face. The text instance stays in case future code wants to
   *  show a one-off thought caption above the head. */
  private readonly faceText: Text
  private readonly bubble = new Container()
  private readonly bubbleBg = new Graphics()
  private readonly bubbleText: Text
  /** Rising air bubbles emitted while the penguin is swimming. */
  private readonly bubbleGraphics = new Graphics()
  private bubbleSpawnAccum = 0
  private airBubbles: Array<{
    x: number
    y: number
    vx: number
    vy: number
    r: number
    /** 1→0 lifetime. */
    t: number
  }> = []

  // --- Expression animation state ---
  /** Random blink loop: countdown until next blink (seconds). */
  private nextBlinkIn = 3 + Math.random() * 2
  /** Live blink animation: 0 = eyes open, 1 = fully closed. */
  private blink = 0
  /** True while a blink is closing (counts up); false while opening (counts down). */
  private blinkClosing = false
  /** Active mood-emote particles. */
  private emotes: EmoteParticle[] = []
  private emoteSpawnAccum = 0
  /** Latest beat pulse, used for flipper flap. */
  private lastBeatPulse = 0
  /**
   * Phase clock for the "cheer wave" alternate-arm swing used in
   * happy/excited/love moods. Advances continuously regardless of beat
   * so the waving stays smooth between drum kicks.
   */
  private cheerWavePhase = Math.random() * Math.PI * 2
  /**
   * Surprise-icon visibility lerp. 0 = hidden, 1 = fully visible.
   * Tracks `mood === 'surprised'` with a fast lerp.
   */
  private surpriseT = 0
  /**
   * One-shot "pop in" bounce for the surprise icon. Set to 1 the
   * frame the mood becomes surprised, decays to 0 over ~0.5 s. Adds an
   * overshoot scale + a tiny vertical hop to the icon's spawn.
   */
  private surprisePop = 0
  /** Dedicated graphics for the head-top "!" surprise icon. */
  private readonly surpriseIcon = new Graphics()
  /**
   * Single-shot vertical-jump state — used by catch celebrations. The
   * body's Y offset gets a sin(πt) parabolic bump for `jumpDuration`
   * seconds so the penguin briefly springs off the deck.
   */
  private jumpT = 0
  private jumpDuration = 0
  private jumpHeight = 0

  private mood: PenguinMood = 'request'
  private wobblePhase = Math.random() * Math.PI * 2
  /** Transient message countdown (ms). When >0, message text shadows the
   *  persistent commission request. */
  private bubbleTimer = 0
  /** The active commission, displayed whenever no transient message is up. */
  private persistentRequest: FishDef | null = null

  // --- Swim-around-the-boat (Fish Frenzy) state ---
  /** True while the penguin should be orbiting (drives the lerp). */
  private wantSwim = false
  /** 0 = on deck, 1 = fully orbiting. Lerps in/out for smooth dive-in. */
  private swimT = 0
  private swimCenterX = 0
  private swimCenterY = 0
  private swimRadiusX = 100
  private swimRadiusY = 30
  /** Current angle in the orbit, radians. */
  private swimAngle = Math.PI
  /** Last position set via setPosition — the "anchor" the swim animation lerps from/to. */
  private restX = 0
  private restY = 0
  /** Horizontal facing while swimming; flips with direction of orbit motion. */
  private swimFacing: 1 | -1 = 1

  constructor() {
    // Z order:
    //   bubbleGraphics (air bubbles, BEHIND body so they trail from behind)
    //   body (squashes/flips on swim)
    //     bodyBg       (body shape, beak, eye whites baseline)
    //     flippers     (animated arm overlay)
    //     face         (eyes/brows/mouth — re-drawn each frame)
    //   emoteGraphics (mood particles, NOT squashed)
    //   bubble (speech bubble)
    this.container.addChild(
      this.bubbleGraphics,
      this.body,
      this.emoteGraphics,
      this.surpriseIcon,
      this.bubble,
    )
    this.body.addChild(this.bodyBg, this.flippers, this.face)
    // Surprise icon starts hidden — it's lerped in by `redrawSurpriseIcon`
    // when the mood is set to 'surprised'.
    this.surpriseIcon.visible = false

    // Legacy ASCII face — kept around but invisible. The new vector
    // face does the heavy lifting; this is just a holster in case
    // future code wants to bind text to it.
    this.faceText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 18,
        fontFamily: 'Menlo, Consolas, monospace',
        fill: '#1f1300',
      }),
    })
    this.faceText.anchor.set(0.5)
    this.faceText.visible = false
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
    this.restX = x
    this.restY = y
    // While orbiting, position is driven by the swim animation. The
    // rest anchor is still tracked so the swim transition can lerp
    // back to the boat smoothly on exit.
    if (this.swimT < 0.001) {
      this.container.position.set(x, y)
    }
  }

  /**
   * Enter / continue the "diving and swimming around the boat" frenzy
   * cameo. Idempotent — each call refreshes the orbit centre so the
   * animation tracks the boat as it bobs on the waves.
   *
   * @param cx  Orbit centre X (typically boat centre).
   * @param cy  Orbit centre Y (typically just below the waterline).
   * @param rx  Horizontal radius.
   * @param ry  Vertical radius (kept smallish so the orbit reads as
   *            a flat ellipse from the side rather than a tall circle).
   */
  swimAroundBoat(cx: number, cy: number, rx = 100, ry = 30): void {
    if (!this.wantSwim) {
      // Fresh orbit — start the penguin at the BACK of the boat so
      // it's clearly visible as a "dive entry" rather than spawning
      // mid-stride.
      this.swimAngle = Math.PI
    }
    this.wantSwim = true
    this.swimCenterX = cx
    this.swimCenterY = cy
    this.swimRadiusX = rx
    this.swimRadiusY = ry
  }

  /** Stop the swim cameo and lerp back onto the deck. Safe to call repeatedly. */
  returnToBoat(): void {
    this.wantSwim = false
  }

  /** True if the swim cameo is on-screen (in transition or fully active). */
  isSwimming(): boolean {
    return this.swimT > 0.01
  }

  setMood(mood: PenguinMood): void {
    if (this.mood !== mood) {
      const becomingSurprised = mood === 'surprised' && this.mood !== 'surprised'
      this.mood = mood
      // Reset emote spawn so the new mood's particles start cleanly
      // instead of inheriting the previous mood's timer.
      this.emoteSpawnAccum = 0
      this.drawPenguin()
      // First frame of a brand-new surprise: arm the icon "pop" so the
      // exclamation mark blasts into view rather than fading.
      if (becomingSurprised) {
        this.surprisePop = 1
      }
    }
  }

  /**
   * Trigger a short vertical jump — used for catch celebrations. The
   * jump lasts `durationSec` and reaches `heightPx` at its apex (sin
   * curve). Overrides any in-flight jump.
   */
  triggerJump(heightPx = 18, durationSec = 0.45): void {
    this.jumpT = 0
    this.jumpDuration = durationSec
    this.jumpHeight = heightPx
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
    // Catch-celebration vertical jump: parabolic sin(πt) curve so the
    // body briefly springs off the deck and lands cleanly. Suppressed
    // mid-swim because the swim orbit owns container.y and the body's
    // local jump would just fight it.
    let jumpOffset = 0
    if (this.jumpT < this.jumpDuration && this.swimT < 0.4) {
      this.jumpT += dtSeconds
      const t01 = Math.min(1, this.jumpT / this.jumpDuration)
      jumpOffset = this.jumpHeight * Math.sin(t01 * Math.PI)
    }
    this.body.position.set(
      sway,
      Math.sin(this.wobblePhase * 0.9) * 1.5 - beatBob - jumpOffset,
    )
    // Slight squash on beat impact so the bob reads as "landing".
    // Plus a small landing squash for the catch jump as it descends.
    const jumpSquash =
      this.jumpDuration > 0 && this.jumpT > this.jumpDuration * 0.85
        ? Math.max(0, (this.jumpT - this.jumpDuration * 0.85) / (this.jumpDuration * 0.15))
        : 0
    const squash = 1 + beatPulse * 0.08 + jumpSquash * 0.18

    // --- Swim orbit (Fish Frenzy cameo) ---
    const swimTarget = this.wantSwim ? 1 : 0
    this.swimT += (swimTarget - this.swimT) * Math.min(1, dtSeconds * 2.4)

    if (this.swimT > 0.001) {
      // ~3.5s per full orbit while at full swim. Slow down during the
      // lerp-in so the dive entry doesn't strobe.
      this.swimAngle += dtSeconds * (1.4 + this.swimT * 0.6)
      const orbitX = this.swimCenterX + Math.cos(this.swimAngle) * this.swimRadiusX
      const orbitY = this.swimCenterY + Math.sin(this.swimAngle) * this.swimRadiusY
      // Blend FROM rest (deck) anchor TO orbit position by swimT.
      const x = this.restX + (orbitX - this.restX) * this.swimT
      const y = this.restY + (orbitY - this.restY) * this.swimT
      this.container.position.set(x, y)
      // Face the direction the orbit is heading.
      const dirX = -Math.sin(this.swimAngle)
      this.swimFacing = dirX >= 0 ? 1 : -1
    }

    // Apply scale.x — squash on Y, plus mirror on X while orbiting.
    const facing = this.swimT > 0.5 ? this.swimFacing : 1
    this.body.scale.set(facing * squash, 2 - squash)

    // Air bubbles trail from the swimming penguin. Spawn rate scales
    // with swimT so they fade in/out alongside the dive animation.
    this.updateBubbles(dtSeconds)

    // --- Expression lifecycle ---
    // Random blink loop. We close fast (~120 ms) and open just as fast,
    // then queue the next blink 2.5–5 s out. Blink looks weird while
    // swimming, so we throttle that case.
    this.tickBlink(dtSeconds)
    // Mood emote particles (tears / hearts / etc.) drift around the
    // head area. Spawn rate is mood-specific.
    this.tickEmotes(dtSeconds)
    // Cheer-wave phase advances continuously so the alternate-arm
    // swing stays smooth between beats. ~0.8 cycles per second.
    this.cheerWavePhase += dtSeconds * 5
    // Surprise icon visibility lerp (target = 1 while mood is
    // surprised, else 0). Pop overshoot decays separately.
    const surpriseTarget = this.mood === 'surprised' ? 1 : 0
    this.surpriseT += (surpriseTarget - this.surpriseT) * Math.min(1, dtSeconds * 10)
    this.surprisePop = Math.max(0, this.surprisePop - dtSeconds * 3)
    this.redrawSurpriseIcon()
    // Re-draw the face every frame — cheap, and it lets the blink
    // animation and beat-driven highlights live in one place instead
    // of fighting for ownership of the eyes graphic.
    this.lastBeatPulse = beatPulse
    this.redrawFace()

    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dtSeconds * 1000
      if (this.bubbleTimer <= 0) {
        // Transient expired — bring back the persistent request if any.
        this.applyPersistentRequest()
      }
    }
  }

  /**
   * Random blink loop. We collapse the eye to a thin closed slit and
   * pop back open, then wait a random interval before the next blink.
   * Swimming penguins don't blink (their eyes are underwater squinted
   * anyway) so we suppress the loop while diving.
   */
  private tickBlink(dtSeconds: number): void {
    if (this.swimT > 0.6) {
      this.blink = 0
      this.blinkClosing = false
      return
    }
    if (this.blinkClosing) {
      this.blink = Math.min(1, this.blink + dtSeconds * 12)
      if (this.blink >= 1) {
        this.blinkClosing = false
      }
    } else if (this.blink > 0) {
      this.blink = Math.max(0, this.blink - dtSeconds * 12)
    } else {
      this.nextBlinkIn -= dtSeconds
      if (this.nextBlinkIn <= 0) {
        this.blinkClosing = true
        this.nextBlinkIn = 2.5 + Math.random() * 3
      }
    }
  }

  /**
   * Spawn + age + render mood-emote particles. Each mood picks a
   * (kind, rate) profile; emotes drift up-and-away from the head and
   * fade out.
   */
  private tickEmotes(dtSeconds: number): void {
    const profile = emoteProfileFor(this.mood)
    if (profile) {
      this.emoteSpawnAccum += dtSeconds * profile.rate
      while (this.emoteSpawnAccum >= 1) {
        this.emoteSpawnAccum -= 1
        this.spawnEmote(profile.kind)
      }
    } else {
      this.emoteSpawnAccum = 0
    }
    for (const e of this.emotes) {
      e.x += e.vx * dtSeconds
      e.y += e.vy * dtSeconds
      // Tears/sweat fall (positive vy). Hearts/stars/notes rise.
      if (e.kind === 'tear' || e.kind === 'sweat') {
        e.vy += 80 * dtSeconds
      } else {
        e.vy -= 28 * dtSeconds
      }
      e.t -= dtSeconds * (e.kind === 'sparkle' ? 2 : 0.9)
    }
    this.emotes = this.emotes.filter((e) => e.t > 0)
    if (this.emotes.length > 24) this.emotes.splice(0, this.emotes.length - 24)
    this.drawEmotes()
  }

  private spawnEmote(kind: EmoteParticle['kind']): void {
    // Spawn around the upper head area in container-local coords.
    let x = 0
    let y = -20
    let vx = (Math.random() - 0.5) * 18
    let vy = -22 - Math.random() * 14
    let size = 4 + Math.random() * 2
    switch (kind) {
      case 'tear':
        // Spawn at one of the lower-eye corners, falling straight down.
        x = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 2)
        y = -12
        vx = (Math.random() - 0.5) * 6
        vy = 24 + Math.random() * 14
        size = 3
        break
      case 'sweat':
        // Spawn near the forehead (right side, classic anime sweat).
        x = 9 + Math.random() * 4
        y = -22
        vx = 4 + Math.random() * 4
        vy = 20 + Math.random() * 10
        size = 3
        break
      case 'heart':
        x = (Math.random() - 0.5) * 18
        y = -22
        size = 5
        break
      case 'star':
        x = (Math.random() - 0.5) * 26
        y = -24 + (Math.random() - 0.5) * 6
        size = 4 + Math.random() * 1.5
        break
      case 'note':
        x = (Math.random() - 0.5) * 22
        y = -22
        size = 6
        break
      case 'sparkle':
        x = (Math.random() - 0.5) * 30
        y = -20 + (Math.random() - 0.5) * 12
        vx = (Math.random() - 0.5) * 6
        vy = -6 - Math.random() * 6
        size = 2.5 + Math.random()
        break
    }
    this.emotes.push({ kind, x, y, vx, vy, t: 1, size, spin: Math.random() * Math.PI * 2 })
  }

  private drawEmotes(): void {
    const g = this.emoteGraphics
    g.clear()
    if (this.emotes.length === 0) return
    for (const e of this.emotes) {
      const a = Math.min(1, e.t)
      switch (e.kind) {
        case 'tear':
        case 'sweat': {
          const color = e.kind === 'tear' ? 0x55b0ff : 0xa8d8ff
          // Teardrop: small circle + triangle tail pointing up.
          g.poly([e.x, e.y - e.size * 1.3, e.x - e.size * 0.7, e.y, e.x + e.size * 0.7, e.y])
          g.fill({ color, alpha: a * 0.85 })
          g.circle(e.x, e.y + e.size * 0.2, e.size * 0.85)
          g.fill({ color, alpha: a * 0.85 })
          g.circle(e.x - e.size * 0.3, e.y + e.size * 0.1, e.size * 0.25)
          g.fill({ color: 0xffffff, alpha: a })
          break
        }
        case 'heart':
          drawHeartShape(g, e.x, e.y, e.size, 0xff5577, a)
          break
        case 'star':
          drawStarShape(g, e.x, e.y, e.size, 0xffd24a, a)
          break
        case 'note':
          // Eighth note: filled head + a stem.
          g.circle(e.x - 2, e.y + 1, e.size * 0.55)
          g.fill({ color: 0x4a2b00, alpha: a })
          g.rect(e.x - 2 + e.size * 0.45, e.y - e.size * 1.6, 1.2, e.size * 1.6)
          g.fill({ color: 0x4a2b00, alpha: a })
          break
        case 'sparkle': {
          // Four-pointed glint: small diamond.
          const s = e.size
          g.poly([e.x, e.y - s, e.x + s * 0.5, e.y, e.x, e.y + s, e.x - s * 0.5, e.y])
          g.fill({ color: 0xffffff, alpha: a })
          break
        }
      }
    }
  }

  /**
   * Spawn + advance + render air bubbles while swimming. All coords
   * are local to `this.container` (which is positioned at the
   * penguin's centre each frame), so the bubbles drift up RELATIVE
   * to the penguin and never need to know the world transform.
   */
  private updateBubbles(dtSeconds: number): void {
    if (this.swimT > 0.2) {
      this.bubbleSpawnAccum += dtSeconds * (4 + this.swimT * 8)
      while (this.bubbleSpawnAccum > 1) {
        this.bubbleSpawnAccum -= 1
        // Origin: behind the beak/face area. Slight random spread so
        // the trail doesn't look mechanical.
        const x = -6 + (Math.random() - 0.5) * 12
        const y = -4 + (Math.random() - 0.5) * 6
        this.airBubbles.push({
          x,
          y,
          vx: (Math.random() - 0.5) * 14,
          vy: -22 - Math.random() * 20,
          r: 1.4 + Math.random() * 2.2,
          t: 1,
        })
      }
    } else {
      this.bubbleSpawnAccum = 0
    }

    for (const b of this.airBubbles) {
      b.x += b.vx * dtSeconds
      b.y += b.vy * dtSeconds
      // Slight upward acceleration — bubbles rise faster as they
      // shrink (Archimedes).
      b.vy -= 18 * dtSeconds
      // Lateral wobble for organic feel.
      b.vx += Math.sin((b.y + b.r) * 0.1) * 4 * dtSeconds
      b.t -= dtSeconds * 0.85
    }
    this.airBubbles = this.airBubbles.filter((b) => b.t > 0)
    // Hard cap so a long swim can't accumulate.
    if (this.airBubbles.length > 40) {
      this.airBubbles.splice(0, this.airBubbles.length - 40)
    }

    const g = this.bubbleGraphics
    g.clear()
    for (const b of this.airBubbles) {
      const a = b.t * 0.85
      // Outer ring (looks like the bubble's wall).
      g.circle(b.x, b.y, b.r)
      g.stroke({ color: 0xeaf6ff, width: 1.2, alpha: a })
      // Highlight dot.
      g.circle(b.x - b.r * 0.4, b.y - b.r * 0.4, b.r * 0.35)
      g.fill({ color: 0xffffff, alpha: a * 0.85 })
    }
  }

  /**
   * Static body silhouette — re-drawn only on mood change (e.g. for
   * beak shape) since none of these primitives animate per-frame. The
   * eyes/brows/cheeks/mouth move to `redrawFace()` which runs every
   * frame so the blink loop can drive them.
   */
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
    // Beak — shape depends on mood. Round "O" for surprised, slightly
    // smiley curve for happy/love, drooped V for sad/weak, plain
    // triangle otherwise.
    drawBeak(g, this.mood)
    // Eyes/brows/etc. live on `this.face` and are re-rendered every
    // frame from `redrawFace()` so the blink animation can override
    // them without dirty-checking.
  }

  /** Hand-drawn face — eyes/brows/mouth/cheeks. Driven by mood + blink. */
  private redrawFace(): void {
    const g = this.face
    g.clear()
    // Cheeks first (under everything) for moods that should look flushed.
    if (
      this.mood === 'happy' ||
      this.mood === 'love' ||
      this.mood === 'proud' ||
      this.mood === 'excited' ||
      this.mood === 'request'
    ) {
      g.circle(-13, -10, 2.4)
      g.fill({ color: 0xff9aa2, alpha: 0.75 })
      g.circle(13, -10, 2.4)
      g.fill({ color: 0xff9aa2, alpha: 0.75 })
    }
    // Worried mood gets slanted angry/concerned brows above the eyes.
    if (this.mood === 'worried' || this.mood === 'sad') {
      const tilt = this.mood === 'worried' ? -1.2 : -2
      g.moveTo(-9, -20)
      g.lineTo(-3, -20 + tilt)
      g.stroke({ color: 0x1a0500, width: 1.4, cap: 'round' })
      g.moveTo(3, -20 + tilt)
      g.lineTo(9, -20)
      g.stroke({ color: 0x1a0500, width: 1.4, cap: 'round' })
    }
    // Proud / smug brows arch upward slightly.
    if (this.mood === 'proud') {
      g.moveTo(-10, -21)
      g.lineTo(-3, -23)
      g.stroke({ color: 0x1a0500, width: 1.4, cap: 'round' })
      g.moveTo(3, -23)
      g.lineTo(10, -21)
      g.stroke({ color: 0x1a0500, width: 1.4, cap: 'round' })
    }

    // Eyes. When mid-blink, ignore the mood eyes and draw a closed slit.
    if (this.blink > 0.4) {
      drawClosedArc(g, -6, -16)
      drawClosedArc(g, 6, -16)
    } else {
      drawEyesFor(g, this.mood, this.lastBeatPulse)
    }

    // Small mouth curve under the beak for moods that need extra cue.
    drawMouthCurve(g, this.mood)

    // Flippers also re-rendered each frame so they can flap on the beat.
    this.redrawFlippers()
  }

  /**
   * Mood-driven flipper pose. Hands up for cheer moods, drooped down
   * for sad/weak, spread out for surprised, neutral hang otherwise.
   * Each frame we add a small beat-driven flap.
   */
  private redrawFlippers(): void {
    const g = this.flippers
    g.clear()
    // Resting angles in radians measured FROM the body anchor point,
    // 0 = pointing right, π/2 = pointing down. Different per flipper
    // because they're on opposite sides of the body.
    let leftAngle = 2.1 // pointing down-left
    let rightAngle = 1.0 // pointing down-right
    switch (this.mood) {
      case 'happy':
      case 'excited':
      case 'love':
        // Arms up cheering.
        leftAngle = -1.9
        rightAngle = -1.2
        break
      case 'proud':
        // Akimbo-ish: out + slightly up.
        leftAngle = 2.8
        rightAngle = 0.3
        break
      case 'surprised':
        // Spread out wide.
        leftAngle = 2.9
        rightAngle = 0.25
        break
      case 'sad':
      case 'weak':
        // Close in and drooped.
        leftAngle = 2.4
        rightAngle = 0.7
        break
      case 'worried':
        // Hands raised to face.
        leftAngle = -2.4
        rightAngle = -0.7
        break
    }
    // Beat flap: small angular nudge, alternating per flipper.
    const flap = this.lastBeatPulse * 0.35
    leftAngle -= flap
    rightAngle += flap
    // Cheer wave overlay — for the energetic moods we layer a big
    // alternating swing on top of the base pose so the arms read as
    // an enthusiastic "waving hello" instead of a static cheer pose.
    // Left and right flippers move in opposite phase (one up while
    // the other down) for the classic crowd-wave silhouette.
    if (this.mood === 'happy' || this.mood === 'excited' || this.mood === 'love') {
      const waveAmp = this.mood === 'excited' ? 0.85 : 0.6
      const wave = Math.sin(this.cheerWavePhase) * waveAmp
      leftAngle += wave
      rightAngle -= wave
    }
    drawFlipperArm(g, -18, 8, leftAngle, 16)
    drawFlipperArm(g, 18, 8, rightAngle, 16)
  }

  /**
   * Head-top "!" surprise icon. Lives independently of the face redraw
   * because (a) it sits above the body, not on it, and (b) it animates
   * its own pop-in bounce that's decoupled from blinking / beat flap.
   */
  private redrawSurpriseIcon(): void {
    const g = this.surpriseIcon
    // Hide entirely once visibility is essentially zero — avoids
    // drawing invisible geometry every frame for the common case
    // where the penguin isn't surprised.
    if (this.surpriseT < 0.02) {
      if (g.visible) {
        g.visible = false
        g.clear()
      }
      return
    }
    g.visible = true
    g.clear()
    // Pop overshoot: peaks at 1 the frame surprise becomes active,
    // decays. Adds an extra +40% scale and a small upward hop so the
    // icon punches into view.
    const pop = this.surprisePop
    const scale = this.surpriseT * (1 + pop * 0.4)
    const hop = Math.sin(Math.min(1, pop) * Math.PI) * -3
    // Position above the head. The penguin head sits around y=-26 in
    // body-local; the icon container is in the penguin container so
    // we just want it ~40 px above the body anchor.
    g.position.set(0, -42 + hop)
    g.scale.set(scale, scale)
    g.alpha = this.surpriseT
    // The "!" itself: yellow body with a dark red outline so it pops
    // against both bright sky and shadowy boat hull.
    const fill = { color: 0xfff088 }
    const stroke = { color: 0xa83a14, width: 1.6 }
    // Bar
    g.roundRect(-2.2, -10, 4.4, 11, 1.6)
    g.fill(fill)
    g.stroke(stroke)
    // Dot
    g.circle(0, 5, 2.4)
    g.fill(fill)
    g.stroke(stroke)
    // Faint motion lines on initial pop for extra punch.
    if (pop > 0.05) {
      const lineAlpha = pop * 0.7
      g.moveTo(-9, -8).lineTo(-5, -6)
      g.moveTo(9, -8).lineTo(5, -6)
      g.moveTo(-10, 0).lineTo(-6, 0)
      g.moveTo(10, 0).lineTo(6, 0)
      g.stroke({ color: 0xfff088, width: 1.4, alpha: lineAlpha })
    }
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

// ============================================================================
// Drawing helpers (module-private — keep Penguin.ts self-contained)
// ============================================================================

/** Picks an emote profile (kind + spawn rate) for a mood, or null. */
function emoteProfileFor(
  mood: PenguinMood,
): { kind: EmoteParticle['kind']; rate: number } | null {
  switch (mood) {
    case 'sad':
      return { kind: 'tear', rate: 1.2 }
    case 'weak':
      return { kind: 'tear', rate: 0.5 }
    case 'worried':
      return { kind: 'sweat', rate: 0.7 }
    case 'love':
      return { kind: 'heart', rate: 1.6 }
    case 'excited':
      return { kind: 'star', rate: 2.4 }
    case 'happy':
      return { kind: 'note', rate: 1 }
    case 'request':
      return { kind: 'sparkle', rate: 1.4 }
    default:
      return null
  }
}

function drawBeak(g: Graphics, mood: PenguinMood): void {
  if (mood === 'surprised') {
    // Open beak: round "O".
    g.circle(0, -3, 3.4)
    g.fill(0xffa728)
    g.circle(0, -3, 2)
    g.fill(0x6a3a14)
  } else if (mood === 'happy' || mood === 'love' || mood === 'excited') {
    // Slightly upturned smiley triangle (curved bottom).
    g.poly([0, -6, -5, 0, 5, 0])
    g.fill(0xffa728)
    g.moveTo(-4, -0.5)
    g.quadraticCurveTo(0, 2.5, 4, -0.5)
    g.fill(0xffa728)
  } else if (mood === 'sad' || mood === 'weak') {
    // Drooped beak — slight downward V.
    g.poly([0, -4, -5, 2, 5, 2])
    g.fill(0xffa728)
  } else {
    // Default triangle beak.
    g.poly([0, -6, -5, 0, 5, 0])
    g.fill(0xffa728)
  }
}

/**
 * Draws BOTH eyes for the given mood, centred at canonical eye anchor
 * points (-6, -16) and (6, -16).
 */
function drawEyesFor(g: Graphics, mood: PenguinMood, beatPulse: number): void {
  const lx = -6
  const rx = 6
  const y = -16
  switch (mood) {
    case 'happy':
      drawArcUp(g, lx, y)
      drawArcUp(g, rx, y)
      break
    case 'sad':
      drawArcDown(g, lx, y + 1)
      drawArcDown(g, rx, y + 1)
      break
    case 'weak':
      drawX(g, lx, y)
      drawX(g, rx, y)
      break
    case 'request':
      drawEagerEye(g, lx, y, beatPulse)
      drawEagerEye(g, rx, y, beatPulse)
      break
    case 'excited':
      drawStarShape(g, lx, y, 4, 0xffd24a, 1)
      drawStarShape(g, rx, y, 4, 0xffd24a, 1)
      break
    case 'surprised':
      drawWideEye(g, lx, y - 1)
      drawWideEye(g, rx, y - 1)
      break
    case 'love':
      drawHeartShape(g, lx, y, 4, 0xff5577, 1)
      drawHeartShape(g, rx, y, 4, 0xff5577, 1)
      break
    case 'wink':
      drawArcUp(g, lx, y)
      drawDotEye(g, rx, y)
      break
    case 'proud':
      drawSmugLid(g, lx, y)
      drawSmugLid(g, rx, y)
      break
    case 'worried':
      drawSmallDot(g, lx, y)
      drawSmallDot(g, rx, y)
      break
    case 'neutral':
    default:
      drawDotEye(g, lx, y)
      drawDotEye(g, rx, y)
      break
  }
}

function drawMouthCurve(g: Graphics, mood: PenguinMood): void {
  // Small accent line below the beak. Many moods skip it (the beak
  // alone reads cleanly); we only add a tiny curve for moods where
  // it materially changes the read.
  switch (mood) {
    case 'sad':
    case 'worried':
      g.moveTo(-3, 5)
      g.quadraticCurveTo(0, 7, 3, 5)
      g.stroke({ color: 0x4a1820, width: 1.2, cap: 'round' })
      break
    case 'happy':
    case 'love':
      g.moveTo(-3, 4)
      g.quadraticCurveTo(0, 2, 3, 4)
      g.stroke({ color: 0x4a1820, width: 1.2, cap: 'round' })
      break
    default:
      // No mouth accent.
      break
  }
}

function drawDotEye(g: Graphics, x: number, y: number): void {
  g.circle(x, y, 3)
  g.fill(0xffffff)
  g.circle(x, y, 1.4)
  g.fill(0x1a0500)
  // Tiny highlight catchlight.
  g.circle(x - 0.7, y - 0.7, 0.5)
  g.fill({ color: 0xffffff, alpha: 0.9 })
}

function drawSmallDot(g: Graphics, x: number, y: number): void {
  g.circle(x, y, 2)
  g.fill(0xffffff)
  g.circle(x, y, 0.9)
  g.fill(0x1a0500)
}

function drawWideEye(g: Graphics, x: number, y: number): void {
  g.circle(x, y, 4.5)
  g.fill(0xffffff)
  g.stroke({ color: 0x1a0500, width: 0.7 })
  g.circle(x, y, 1.2)
  g.fill(0x1a0500)
  g.circle(x - 1, y - 1, 0.8)
  g.fill({ color: 0xffffff, alpha: 0.95 })
}

function drawEagerEye(g: Graphics, x: number, y: number, beatPulse: number): void {
  // Standard eye with a beat-driven shine that pops on each kick.
  const shineR = 0.7 + beatPulse * 0.6
  g.circle(x, y, 3.4)
  g.fill(0xffffff)
  g.circle(x, y, 1.6)
  g.fill(0x1a0500)
  g.circle(x - 0.9, y - 0.9, shineR)
  g.fill({ color: 0xffffff, alpha: 1 })
}

function drawArcUp(g: Graphics, x: number, y: number): void {
  // ^_^ closed-eye smile arc.
  g.moveTo(x - 4, y + 1.5)
  g.quadraticCurveTo(x, y - 2.5, x + 4, y + 1.5)
  g.stroke({ color: 0x1a0500, width: 1.6, cap: 'round' })
}

function drawArcDown(g: Graphics, x: number, y: number): void {
  // u sad / droopy arc.
  g.moveTo(x - 4, y - 1.5)
  g.quadraticCurveTo(x, y + 2.5, x + 4, y - 1.5)
  g.stroke({ color: 0x1a0500, width: 1.6, cap: 'round' })
}

function drawClosedArc(g: Graphics, x: number, y: number): void {
  // Generic closed eye line for blink.
  g.moveTo(x - 4, y)
  g.quadraticCurveTo(x, y + 1.5, x + 4, y)
  g.stroke({ color: 0x1a0500, width: 1.5, cap: 'round' })
}

function drawX(g: Graphics, x: number, y: number): void {
  const s = 3
  g.moveTo(x - s, y - s)
  g.lineTo(x + s, y + s)
  g.moveTo(x + s, y - s)
  g.lineTo(x - s, y + s)
  g.stroke({ color: 0x1a0500, width: 1.6, cap: 'round' })
}

function drawSmugLid(g: Graphics, x: number, y: number): void {
  // Half-closed: a horizontal slit + a small curve hint below.
  g.rect(x - 4, y - 0.5, 8, 1)
  g.fill(0x1a0500)
  g.moveTo(x - 3, y + 1)
  g.quadraticCurveTo(x, y + 2.4, x + 3, y + 1)
  g.stroke({ color: 0x1a0500, width: 1, cap: 'round' })
}

function drawStarShape(
  g: Graphics,
  cx: number,
  cy: number,
  radius: number,
  color: number,
  alpha: number,
): void {
  const outer = radius
  const inner = radius * 0.45
  const pts: number[] = []
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
  }
  g.poly(pts)
  g.fill({ color, alpha })
}

function drawHeartShape(
  g: Graphics,
  cx: number,
  cy: number,
  size: number,
  color: number,
  alpha: number,
): void {
  // Two top lobes + a triangular bottom.
  const r = size * 0.42
  g.circle(cx - r, cy - r * 0.3, r)
  g.fill({ color, alpha })
  g.circle(cx + r, cy - r * 0.3, r)
  g.fill({ color, alpha })
  g.poly([
    cx - size * 0.95, cy,
    cx + size * 0.95, cy,
    cx, cy + size * 1.05,
  ])
  g.fill({ color, alpha })
}

/**
 * Draws one flipper "arm" as a thick rounded stroke from an anchor on
 * the body to a tip at angle/length.
 */
function drawFlipperArm(
  g: Graphics,
  anchorX: number,
  anchorY: number,
  angleRad: number,
  length: number,
): void {
  const tx = anchorX + Math.cos(angleRad) * length
  const ty = anchorY + Math.sin(angleRad) * length
  g.moveTo(anchorX, anchorY)
  g.lineTo(tx, ty)
  g.stroke({ color: 0x141414, width: 6, cap: 'round' })
  // A small lighter highlight along the upper edge of the arm so it
  // doesn't disappear against the body silhouette.
  const perpX = Math.cos(angleRad - Math.PI / 2) * 1.4
  const perpY = Math.sin(angleRad - Math.PI / 2) * 1.4
  g.moveTo(anchorX + perpX, anchorY + perpY)
  g.lineTo(tx + perpX, ty + perpY)
  g.stroke({ color: 0x3a3a3a, width: 1.2, alpha: 0.7 })
}
