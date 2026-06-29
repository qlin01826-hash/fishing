import { Container, Graphics, Text, TextStyle } from 'pixi.js'

/**
 * The mermaid-on-a-rock that the boat "passes by" during every
 * enhanced-beat event (follow / run).
 *
 * Visually it tells the player that the brass + choir + flute tag they
 * hear at the start of an enhanced beat is being SUNG by the mermaid —
 * a much stronger feedback cue than a free-floating "EVENT INCOMING"
 * stinger. Each event:
 *
 *   1. `show()` — rock slides in from the right edge of the viewport,
 *      mermaid scrolls in with it (she's parented to the rock).
 *   2. While `state === 'singing'` her mouth pulses open + closed in
 *      time with the BGM, hair sways, and a stream of cartoon ♪ notes
 *      drifts up from her mouth area.
 *   3. `hide()` — rock slides back out off-screen; notes finish their
 *      flight and recycle.
 *
 * Drawn entirely from primitives; no sprite assets.
 */
interface FloatingNote {
  graphic: Text
  vx: number
  vy: number
  life: number
  spin: number
}

export class MermaidRock {
  readonly container = new Container()

  private readonly rock = new Graphics()
  private readonly tailBack = new Graphics()
  private readonly tail = new Graphics()
  private readonly body = new Graphics()
  private readonly hairBack = new Graphics()
  private readonly hairFront = new Graphics()
  private readonly face = new Graphics()
  private readonly mouth = new Graphics()
  private readonly notesLayer = new Container()
  private readonly aura = new Graphics()
  /**
   * Dedicated moonlight halo — wider and cooler than the singing aura,
   * always-on whenever night strength is non-zero. Drawn BEHIND the
   * regular aura so the aura's warm pulse stacks on top.
   */
  private readonly moonAura = new Graphics()
  /** 0..1 lerped strength of the moonlight aura. */
  private moonlight = 0

  /** Floating ♪ notes currently in flight. */
  private notes: FloatingNote[] = []

  private targetX = 0
  private offscreenX = 0
  private anchorY = 0
  private state: 'hidden' | 'entering' | 'singing' | 'exiting' = 'hidden'
  private slideT = 0
  private hairPhase = Math.random() * Math.PI * 2
  private mouthPhase = 0
  private auraPhase = 0
  private noteSpawnTimer = 0

  constructor() {
    this.container.addChild(
      this.moonAura,
      this.aura,
      this.rock,
      this.tailBack,
      this.hairBack,
      this.body,
      this.tail,
      this.face,
      this.mouth,
      this.hairFront,
      this.notesLayer,
    )
    this.container.visible = false
    this.drawRock()
    this.drawBody()
    this.drawTail()
    this.drawFace()
  }

  /**
   * Resync to the current viewport. The rock sits in the water on the
   * right side of the screen; off-screen is just past the right edge so
   * the slide-in is always horizontal. Y is anchored to the water line
   * so the rock pokes out of the waves no matter the viewport height.
   */
  setLayout(viewportWidth: number, waterLineY: number): void {
    // Pull the rock a bit further inboard on narrow phones so the
    // mermaid is fully visible, even when the playfield is short.
    const insetFromRight = Math.max(110, Math.min(170, viewportWidth * 0.18))
    this.targetX = viewportWidth - insetFromRight
    this.offscreenX = viewportWidth + 140
    this.anchorY = waterLineY + 4 // rock base sits slightly under the waterline
    const x = this.state === 'hidden' || this.state === 'entering' ? this.offscreenX : this.targetX
    this.container.position.set(x, this.anchorY)
  }

  show(): void {
    if (this.state === 'singing' || this.state === 'entering') return
    this.state = 'entering'
    this.slideT = 0
    this.container.visible = true
  }

  hide(): void {
    if (this.state === 'hidden' || this.state === 'exiting') return
    this.state = 'exiting'
    this.slideT = 0
  }

  isVisible(): boolean {
    return this.state !== 'hidden'
  }

  /**
   * Set the desired moonlight intensity (0 = no glow, 1 = full moon).
   * The actual rendered value is lerped each frame so the lighting
   * eases in/out smoothly as the day cycle rotates.
   */
  setMoonlight(target: number): void {
    this.moonlightTarget = Math.max(0, Math.min(1, target))
  }
  private moonlightTarget = 0

  update(dtSeconds: number): void {
    // Slide animation
    if (this.state === 'entering') {
      this.slideT = Math.min(1, this.slideT + dtSeconds * 3.4)
      const e = easeOutBack(this.slideT)
      this.container.x = this.offscreenX + (this.targetX - this.offscreenX) * e
      if (this.slideT >= 1) {
        this.state = 'singing'
        this.container.x = this.targetX
      }
    } else if (this.state === 'exiting') {
      this.slideT = Math.min(1, this.slideT + dtSeconds * 2.8)
      const e = easeInBack(this.slideT)
      this.container.x = this.targetX + (this.offscreenX - this.targetX) * e
      if (this.slideT >= 1) {
        this.state = 'hidden'
        this.container.visible = false
        for (const n of this.notes) this.notesLayer.removeChild(n.graphic)
        this.notes = []
      }
    }

    // Hair sway is always animating so it doesn't look dead while she
    // glides in/out either.
    this.hairPhase += dtSeconds * 1.6
    this.drawHair(Math.sin(this.hairPhase) * 0.06)

    // Aura halo (faint glow behind her) pulses regardless of state.
    this.auraPhase += dtSeconds * 2.5
    if (this.state === 'singing' || this.state === 'entering') {
      const intensity = Math.max(0, Math.sin(this.auraPhase) * 0.5 + 0.5)
      this.drawAura(intensity)
    } else {
      this.drawAura(0)
    }
    // Moonlight aura: lerps toward the latched target and is drawn
    // even when she's off-screen (it'll fade out smoothly that way
    // too). The visible-only bail-out is unnecessary because an empty
    // graphics costs almost nothing.
    this.moonlight += (this.moonlightTarget - this.moonlight) * Math.min(1, dtSeconds * 1.5)
    if (this.state !== 'hidden' && this.moonlight > 0.01) {
      // Subtle slow breath stacked on top of the time-of-day fade.
      const breath = 0.85 + 0.15 * Math.sin(this.auraPhase * 0.6)
      this.drawMoonAura(this.moonlight * breath)
    } else {
      this.moonAura.clear()
    }

    // Singing — mouth pulses + notes spawn.
    if (this.state === 'singing') {
      this.mouthPhase += dtSeconds * 7
      // Two layered sinusoids gives an irregular "lyrical" opening
      // rather than a uniform robotic pulse.
      const open = Math.max(
        0,
        0.5 + 0.5 * Math.sin(this.mouthPhase) + 0.2 * Math.sin(this.mouthPhase * 0.43),
      )
      this.drawMouth(Math.min(1, open))

      this.noteSpawnTimer -= dtSeconds * 1000
      if (this.noteSpawnTimer <= 0) {
        this.spawnNote()
        this.noteSpawnTimer = 180 + Math.random() * 180
      }
    } else {
      this.drawMouth(0)
    }

    // Update flying notes
    for (const note of this.notes) {
      note.life -= dtSeconds
      note.graphic.position.x += note.vx * dtSeconds
      note.graphic.position.y += note.vy * dtSeconds
      note.vy -= 22 * dtSeconds // additional upward acceleration
      note.graphic.rotation += note.spin * dtSeconds
      note.graphic.alpha = Math.max(0, Math.min(1, note.life / 0.4))
    }
    if (this.notes.some((n) => n.life <= 0)) {
      const survivors: FloatingNote[] = []
      for (const note of this.notes) {
        if (note.life <= 0) this.notesLayer.removeChild(note.graphic)
        else survivors.push(note)
      }
      this.notes = survivors
    }
  }

  // ---- drawing ----

  private drawRock(): void {
    const g = this.rock
    g.clear()
    // Dark splash under the rock — visible flowing water around base.
    g.ellipse(0, 8, 64, 7)
    g.fill({ color: 0x0a1830, alpha: 0.35 })
    // Main rock body (irregular polygon, soft gray with seafoam highlight).
    g.poly([
      -52, 6,
      -48, -8,
      -34, -22,
      -16, -28,
      4, -30,
      24, -24,
      40, -10,
      46, 2,
      44, 8,
      -50, 8,
    ])
    g.fill(0x556677)
    // Wet shading on the lower half.
    g.poly([
      -50, 8,
      -48, -2,
      -32, -14,
      -10, -18,
      18, -16,
      36, -8,
      44, 2,
      44, 8,
    ])
    g.fill({ color: 0x33414e, alpha: 0.55 })
    // Two algae tufts.
    g.ellipse(-30, -2, 8, 4)
    g.fill(0x6db26b)
    g.ellipse(28, 0, 6, 3)
    g.fill(0x6db26b)
    // Seafoam splashing on the rock's waterline.
    g.ellipse(0, 6, 50, 3)
    g.fill({ color: 0xfff5e0, alpha: 0.8 })
  }

  private drawBody(): void {
    const g = this.body
    g.clear()
    // Sitting torso — soft peach skin colour, half-twist pose.
    g.ellipse(0, -42, 14, 18)
    g.fill(0xfacba0)
    // Slight shading on the side facing away from the light.
    g.ellipse(4, -42, 6, 16)
    g.fill({ color: 0xd99a72, alpha: 0.4 })
    // Sea-shell bikini top (pink scallops).
    g.ellipse(-5, -42, 5, 4)
    g.fill(0xff9aa2)
    g.ellipse(6, -42, 5, 4)
    g.fill(0xff9aa2)
    // Bikini centre tie
    g.rect(-1, -42, 2, 2)
    g.fill(0xff5577)
    // Arm draped on tail (curved triangle).
    g.poly([4, -34, 18, -22, 10, -16, 0, -30])
    g.fill(0xfacba0)
  }

  private drawTail(): void {
    const g = this.tail
    g.clear()
    // Tail base — flowing down the side of the rock. Use two layered
    // ellipses for the "twist" effect (Disney-style mermaid pose).
    g.ellipse(2, -16, 18, 16)
    g.fill(0x3aa1c4)
    g.ellipse(18, -8, 22, 10)
    g.fill(0x3aa1c4)
    // Scale highlights — three diagonal arcs across the tail.
    for (let i = 0; i < 3; i += 1) {
      g.ellipse(8 + i * 6, -14 + i * 3, 8, 3)
      g.fill({ color: 0x8fe3f4, alpha: 0.5 })
    }
    // Tail fin (the iconic split-leaf flick).
    g.poly([34, -10, 50, -28, 48, -4, 56, 4, 38, 2])
    g.fill(0x5fbbd9)
    g.poly([34, -10, 50, -28, 48, -4, 56, 4, 38, 2])
    g.stroke({ color: 0x2a7c98, width: 1.5 })

    // The "back" of the tail wraps around the rock — drawn earlier in
    // z-order so it tucks behind the body.
    const back = this.tailBack
    back.clear()
    back.ellipse(-12, -10, 14, 8)
    back.fill(0x2f8aa9)
  }

  private drawFace(): void {
    const g = this.face
    g.clear()
    // Face — round, slightly tilted upward (she's singing UP to the sky).
    g.ellipse(0, -60, 9, 11)
    g.fill(0xffe1c0)
    // Eyes — closed in song, drawn as upward-curving arc lines.
    g.moveTo(-4, -62)
    g.quadraticCurveTo(-2.5, -64, -1, -62)
    g.stroke({ color: 0x3a2810, width: 1.2, cap: 'round' })
    g.moveTo(1, -62)
    g.quadraticCurveTo(2.5, -64, 4, -62)
    g.stroke({ color: 0x3a2810, width: 1.2, cap: 'round' })
    // Cheek blush
    g.circle(-4, -57, 1.4)
    g.fill({ color: 0xff9aa2, alpha: 0.7 })
    g.circle(4, -57, 1.4)
    g.fill({ color: 0xff9aa2, alpha: 0.7 })
    // Mouth gets re-drawn each frame in drawMouth().
  }

  private drawMouth(open: number): void {
    const g = this.mouth
    g.clear()
    const w = 2.2
    const h = 0.6 + open * 3.6
    // Open mouth oval at the bottom of the face.
    g.ellipse(0, -55, w, h)
    g.fill(0x4a1820)
    // Highlighted lip top edge.
    g.ellipse(0, -55 - h, w, 0.6)
    g.fill({ color: 0xff8e9a, alpha: 0.85 })
  }

  private drawHair(swayRad: number): void {
    const back = this.hairBack
    const front = this.hairFront
    back.clear()
    front.clear()
    // Two flowing locks behind, one bang in front. The sway angle
    // controlled by the caller, applied around the face anchor.
    const cos = Math.cos(swayRad)
    const sin = Math.sin(swayRad)
    const pivotY = -60
    const transform = (x: number, y: number): [number, number] => {
      const dx = x
      const dy = y - pivotY
      return [dx * cos - dy * sin, dx * sin + dy * cos + pivotY]
    }
    // Back lock — extends down behind body and tail.
    const backPath: [number, number][] = [
      [-8, -68],
      [-14, -56],
      [-18, -38],
      [-16, -22],
      [-10, -12],
      [-4, -68],
    ]
    back.poly(backPath.flatMap(([x, y]) => transform(x, y)))
    back.fill(0x2a4d7a)
    // Long flowing right lock (also behind).
    const sideLock: [number, number][] = [
      [4, -66],
      [12, -54],
      [16, -36],
      [12, -22],
      [8, -16],
      [2, -64],
    ]
    back.poly(sideLock.flatMap(([x, y]) => transform(x, y)))
    back.fill(0x335c92)
    // Front bang — slightly lighter, sweeps across the forehead.
    const bang: [number, number][] = [
      [-7, -67],
      [-3, -64],
      [4, -67],
      [6, -63],
      [-6, -62],
    ]
    front.poly(bang.flatMap(([x, y]) => transform(x, y)))
    front.fill(0x3a6da8)
    // A tiny seaweed-flower hair ornament on the side.
    const [ornamentX, ornamentY] = transform(6, -64)
    front.circle(ornamentX, ornamentY, 2.2)
    front.fill(0xff9aa2)
  }

  private drawAura(intensity: number): void {
    const g = this.aura
    g.clear()
    if (intensity <= 0.01) return
    // Soft cyan halo behind the mermaid that pulses with the BGM.
    g.circle(0, -52, 38 + intensity * 8)
    g.fill({ color: 0x8fe3f4, alpha: 0.08 + intensity * 0.12 })
    g.circle(0, -52, 24 + intensity * 6)
    g.fill({ color: 0xfff5e0, alpha: 0.05 + intensity * 0.08 })
  }

  /**
   * Wide cool halo behind everything — reads as "moonlight pooling
   * around her on the rock". Three stacked discs of decreasing radius
   * and increasing alpha give a soft falloff, and a slim rim-light
   * arc behind the head highlights her silhouette against the night.
   */
  private drawMoonAura(intensity: number): void {
    const g = this.moonAura
    g.clear()
    if (intensity <= 0.01) return
    // Body-centred halo discs (negative-Y because the body sits ABOVE
    // the rock origin at roughly y=-50).
    const cx = 0
    const cy = -46
    g.circle(cx, cy, 88)
    g.fill({ color: 0xa8c7ff, alpha: 0.05 * intensity })
    g.circle(cx, cy, 62)
    g.fill({ color: 0xc6dcff, alpha: 0.08 * intensity })
    g.circle(cx, cy, 42)
    g.fill({ color: 0xe8f0ff, alpha: 0.11 * intensity })
    // Rim light behind the head — a thin crescent above the face.
    g.arc(0, -60, 12, Math.PI + 0.2, 2 * Math.PI - 0.2)
    g.stroke({ color: 0xffffff, width: 2, alpha: 0.4 * intensity })
    // Subtle rim on the tail flick too.
    g.moveTo(36, -8)
    g.lineTo(54, -22)
    g.lineTo(50, 0)
    g.stroke({ color: 0xc6dcff, width: 1.5, alpha: 0.35 * intensity })
  }

  private spawnNote(): void {
    const symbols = ['♪', '♫', '♩']
    const symbol = symbols[Math.floor(Math.random() * symbols.length)]
    const note = new Text({
      text: symbol,
      style: new TextStyle({
        fontSize: 18 + Math.random() * 10,
        fontFamily: 'system-ui, sans-serif',
        fill: 0xfff5e0,
        stroke: { color: 0x3a6da8, width: 2 },
      }),
    })
    note.anchor.set(0.5, 0.5)
    note.position.set(2 + (Math.random() - 0.5) * 4, -54)
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.8
    const speed = 30 + Math.random() * 20
    const entry: FloatingNote = {
      graphic: note,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.4 + Math.random() * 0.4,
      spin: (Math.random() - 0.5) * 4,
    }
    this.notesLayer.addChild(note)
    this.notes.push(entry)
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.7
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

function easeInBack(t: number): number {
  const c1 = 1.7
  const c3 = c1 + 1
  return c3 * t * t * t - c1 * t * t
}
