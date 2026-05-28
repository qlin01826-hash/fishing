import { Container, Graphics } from 'pixi.js'
import type { ViewportContext, WeatherSnapshot } from '../types'

/**
 * The player's fishing boat — drawn entirely from primitives and styled
 * to feel like a happy children's-book tugboat: rounded scarlet hull,
 * yellow racing stripe, white smiley face on the bow, cream cabin with
 * a round porthole, candy-striped mast, and a perky pennant flag.
 *
 * The boat floats with a sinusoid that intensifies in storms, and the
 * scene can sample {@link deckTopY} / {@link deckCenterX} each frame to
 * park the penguin on the deck (so it visibly rides the bob).
 *
 * The boat *position* (world coordinates) is owned by the scene so that
 * other entities (hook, line, penguin) can be parented relative to
 * either the boat or world cleanly.
 */
export class Boat {
  readonly container = new Container()
  /** World-space anchor of the rod tip. Updated each frame. */
  rodTipX = 0
  rodTipY = 0
  /** World-space anchor of the top of the deck — used by scene to
   *  park the penguin so it rides the bob. Updated each frame. */
  deckCenterX = 0
  deckTopY = 0

  private readonly hull = new Graphics()
  private readonly deck = new Graphics()
  private readonly cabin = new Graphics()
  private readonly mast = new Graphics()
  private readonly rod = new Graphics()
  private readonly face = new Graphics()

  private baseX = 0
  private baseY = 0
  private bobPhase = Math.random() * Math.PI * 2

  constructor() {
    this.container.addChild(this.hull, this.face, this.deck, this.cabin, this.mast, this.rod)
  }

  /** Re-anchor on resize. baseY usually = waterLineY. */
  setBase(x: number, y: number): void {
    this.baseX = x
    this.baseY = y
    this.draw()
  }

  update(dtSeconds: number, weather: WeatherSnapshot, elapsedMs: number, viewport: ViewportContext): void {
    this.bobPhase += dtSeconds * (1.4 + weather.intensity * 1.2)
    const amplitude = 4 + weather.intensity * 12
    const lift = Math.sin(this.bobPhase) * amplitude
    const tilt = Math.cos(this.bobPhase * 1.1 + 0.3) * (0.04 + weather.intensity * 0.16)
    this.container.position.set(this.baseX, this.baseY + lift)
    this.container.rotation = tilt
    // Rod tip is the rightmost end of the rod in local space, rotated and translated.
    const rodLocalX = 84
    const rodLocalY = -58
    const cos = Math.cos(tilt)
    const sin = Math.sin(tilt)
    this.rodTipX = this.baseX + rodLocalX * cos - rodLocalY * sin
    this.rodTipY = this.baseY + lift + rodLocalX * sin + rodLocalY * cos
    // Deck-top anchor for the penguin: parked LEFT of the mast (which
    // sits at local x≈-30) so the penguin doesn't visually impale the
    // mast pole. Local deck top is at y=-8.
    const deckLocalX = -54
    const deckLocalY = -8
    this.deckCenterX = this.baseX + deckLocalX * cos - deckLocalY * sin
    this.deckTopY = this.baseY + lift + deckLocalX * sin + deckLocalY * cos
    void elapsedMs
    void viewport
  }

  private draw(): void {
    this.drawHull()
    this.drawFace()
    this.drawDeck()
    this.drawCabin()
    this.drawMast()
    this.drawRod()
  }

  /**
   * Rounded "bathtub" hull with a yellow racing stripe and white trim.
   * Two ellipses give the cartoony belly shape; a polygon clip would be
   * more efficient but ellipses keep the silhouette friendly.
   */
  private drawHull(): void {
    const g = this.hull
    g.clear()
    // Soft drop shadow under the hull on the water.
    g.ellipse(0, 38, 96, 8)
    g.fill({ color: 0x0a1830, alpha: 0.18 })
    // Main hull — rounded scarlet belly.
    g.ellipse(0, 22, 96, 22)
    g.fill(0xe14b4b)
    // White trim above the waterline.
    g.roundRect(-92, 0, 184, 8, 4)
    g.fill(0xfff5e0)
    // Yellow racing stripe just below the trim.
    g.rect(-90, 8, 180, 4)
    g.fill(0xffd24a)
    // Lower-hull darker red curve gives shading.
    g.ellipse(0, 30, 84, 14)
    g.fill({ color: 0xa72d2d, alpha: 0.45 })
    // Three white portholes along the side.
    for (const px of [-50, -16, 18]) {
      g.circle(px, 18, 5)
      g.fill(0xfff5e0)
      g.circle(px, 18, 3)
      g.fill(0x71a3d6)
    }
  }

  /**
   * Friendly face on the bow (right side of hull). Two big eyes + a
   * curved smile. Faces forward (right) since the rod casts off the
   * right side of the boat.
   */
  private drawFace(): void {
    const g = this.face
    g.clear()
    // Eyes
    g.circle(58, 16, 6)
    g.fill(0xffffff)
    g.circle(78, 16, 6)
    g.fill(0xffffff)
    g.circle(60, 17, 3)
    g.fill(0x1a1a2e)
    g.circle(80, 17, 3)
    g.fill(0x1a1a2e)
    // Smile (a thick arc using two stroked lines for a chunky look).
    g.moveTo(54, 28)
    g.quadraticCurveTo(68, 38, 84, 28)
    g.stroke({ color: 0x1a1a2e, width: 3, cap: 'round' })
    // Rosy cheek.
    g.circle(50, 24, 3)
    g.fill({ color: 0xff9aa2, alpha: 0.7 })
  }

  /**
   * Deck planks — bright wood, only on the left half so the penguin
   * has a clear surface to stand on without the cabin behind it.
   */
  private drawDeck(): void {
    const g = this.deck
    g.clear()
    // Cream-coloured plank.
    g.roundRect(-78, -8, 88, 12, 3)
    g.fill(0xe8c79a)
    // Plank lines
    for (let i = -68; i <= 0; i += 18) {
      g.rect(i, -8, 1, 12)
      g.fill({ color: 0x8c5a2c, alpha: 0.45 })
    }
    // Deck rim shadow under the planks.
    g.rect(-78, 4, 88, 2)
    g.fill({ color: 0x6c4a26, alpha: 0.4 })
  }

  /**
   * Cabin with porthole — sits on the right half of the deck. White-
   * cream box with a curved roof; gives the boat a pleasing silhouette
   * and an obvious "front" / "back".
   */
  private drawCabin(): void {
    const g = this.cabin
    g.clear()
    // Cabin body
    g.roundRect(10, -34, 38, 30, 6)
    g.fill(0xfff5e0)
    // Sloped roof accent
    g.roundRect(8, -34, 42, 6, 3)
    g.fill(0x4a8fc7)
    // Round porthole
    g.circle(29, -18, 6)
    g.fill(0x71a3d6)
    g.circle(29, -18, 6)
    g.stroke({ color: 0xfff5e0, width: 2 })
    // Tiny glint highlight on the porthole.
    g.circle(27, -20, 1.6)
    g.fill({ color: 0xffffff, alpha: 0.8 })
  }

  private drawMast(): void {
    const g = this.mast
    g.clear()
    // Mast pole — candy-striped (red + white) for a cheerful look.
    g.rect(-32, -70, 4, 62)
    g.fill(0xfff5e0)
    for (let y = -68; y < -8; y += 8) {
      g.rect(-32, y, 4, 4)
      g.fill(0xe14b4b)
    }
    // Mast cap ball.
    g.circle(-30, -72, 4)
    g.fill(0xffd24a)
    // Triangular pennant flag flapping right.
    g.poly([-28, -70, -8, -62, -28, -56])
    g.fill(0xff6b6b)
    g.moveTo(-28, -70)
    g.lineTo(-28, -56)
    g.stroke({ color: 0xa72d2d, width: 1, alpha: 0.6 })
  }

  private drawRod(): void {
    const g = this.rod
    g.clear()
    // Rod — light tan, from deck (right edge of cabin) up & right to tip.
    g.moveTo(48, -8)
    g.lineTo(84, -58)
    g.stroke({ color: 0x3a2310, width: 4, cap: 'round' })
    g.moveTo(48, -8)
    g.lineTo(84, -58)
    g.stroke({ color: 0xd4a86a, width: 2, alpha: 0.7 })
    // Reel housing at base of rod.
    g.circle(48, -6, 6)
    g.fill(0x2b2b2b)
    g.circle(48, -6, 3)
    g.fill(0xc0c0c0)
    g.circle(48, -6, 1)
    g.fill(0xfff5e0)
  }
}
