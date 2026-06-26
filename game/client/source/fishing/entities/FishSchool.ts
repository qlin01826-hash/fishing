import { Container, Graphics } from 'pixi.js'
import type { FishBodyShape, FishDef, FishSize, ViewportContext } from '../types'
import { FISH_CATALOG, fishEligibleForZone } from '../data/FishCatalog'
import { seabedY } from '../utils/depthTerrain'

/**
 * Physical scale table by size class. Tuned so the difference between
 * a shrimp and a moonfish is dramatic (≈4×) but the school as a whole
 * still reads as a coherent depth band.
 */
const SIZE_SCALE: Record<FishSize, number> = {
  tiny: 0.55,
  small: 0.75,
  medium: 1.0,
  large: 1.4,
  huge: 1.85,
}

/**
 * Which size classes participate in the surface "stand on tail + jump"
 * frenzy dance. Anything larger gets the alternative vertical-bob
 * choreography handled in the main update loop.
 */
const DANCES_AT_SURFACE: Record<FishSize, boolean> = {
  tiny: true,
  small: true,
  medium: false,
  large: false,
  huge: false,
}

interface AmbientFish {
  def: FishDef
  graphic: Graphics
  x: number
  y: number
  vx: number
  scale: number
  phase: number
  /** Natural Y the fish wants to return to once frenzy ends. */
  homeY: number
  /** Per-fish phase offset for the frenzy dance so they don't move in lockstep. */
  danceOffset: number
  /**
   * Transient battle "tug" visual offset (px). Set by BattleState on
   * each beat so the hooked fish visibly jerks toward the rod in time
   * with the music, then decays back to 0 between beats. Layered on
   * top of the swim position — never moves the fish's real `x/y`, so
   * it can't accumulate or drag the fish off its fight path.
   */
  tugX: number
  tugY: number
  /** Transient rotational thrash (radians) layered on the tug. */
  tugRot: number
}

/**
 * Background fish that lazily swim across the depth bands. They are
 * cosmetic until one of them is selected as a "biter" by the scene —
 * at which point the scene asks the school for a candidate fish near
 * the hook.
 */
export class FishSchool {
  readonly container = new Container()
  /**
   * Separate container for the surface splashes. Exposed so the scene
   * can mount it in the ABOVE-water layer (in front of the waves, under
   * the boat) while the fish themselves stay UNDER water.
   */
  readonly splashContainer = new Container()
  private readonly splashGraphics = new Graphics()
  private fish: AmbientFish[] = []
  private viewport: ViewportContext
  private spawnAccumulator = 0
  /** Lerps 0→1 when frenzy starts, 1→0 when it ends. */
  private frenzyT = 0
  /**
   * Externally-supplied beat phase used to drive the tail-wag
   * synchronisation. 0..1 where 0 is the downbeat. Set by FishingScene
   * from the BeatClock so we don't duplicate the beat math here.
   */
  private beatPhase = 0.5
  /** Cached previous-frame beatPhase for downbeat-edge detection. */
  private prevBeatPhase = 0.5
  /** Run depth 0..1 — fish fade into dark silhouettes in the abyss. */
  private depthMood = 0
  private scrollPx = 0
  /** Lure phase: fish gather and sway around the hook (0..1). */
  private lureGather = 0
  private lureHookX = 0
  private lureHookY = 0
  private lureActive = false
  private lureDanceDir: 1 | -1 = 1
  private stageZone = 0
  /**
   * Active surface-splash particles. Lightweight pool — each splash is
   * a single ring + a handful of droplets. We never expect more than
   * ~30 alive at once during a frenzy.
   */
  private splashes: Array<{
    x: number
    y: number
    /** 1 → 0 lifetime. */
    t: number
    /** Maximum ring radius this splash will reach. */
    rMax: number
  }> = []

  constructor(viewport: ViewportContext) {
    this.viewport = viewport
    this.splashContainer.addChild(this.splashGraphics)
    // Splashes are decorative only; never intercept input.
    this.splashContainer.eventMode = 'none'
  }

  /** Toggle the "rise and dance" frenzy choreography. */
  setFrenzyMode(active: boolean): void {
    // Caller drives the lerp via setFrenzyAmount for smooth blending.
    // This setter is here only as a fall-back for callers that don't
    // want to compute their own lerp.
    if (active && this.frenzyT < 1) this.frenzyT = Math.min(1, this.frenzyT + 0.1)
    if (!active && this.frenzyT > 0) this.frenzyT = Math.max(0, this.frenzyT - 0.05)
  }

  /** Direct setter so BattleState can drive a smooth lerp itself. */
  setFrenzyAmount(amount: number): void {
    this.frenzyT = Math.max(0, Math.min(1, amount))
  }

  /** BeatClock-driven phase (0..1) — drives tail wag during frenzy. */
  setBeatPhase(phase: number): void {
    this.beatPhase = phase
  }

  setDepthMood(t: number): void {
    this.depthMood = Math.max(0, Math.min(1, t))
  }

  setWorldScroll(px: number): void {
    this.scrollPx = Math.max(0, px)
  }

  setStageZone(zone: number): void {
    this.stageZone = Math.max(0, Math.min(4, zone))
  }

  /** Drive fish to cluster and dance around the hook during lure. */
  setLureGather(
    amount: number,
    hookX: number,
    hookY: number,
    active: boolean,
    danceDir: 1 | -1 = 1,
  ): void {
    this.lureGather = Math.max(0, Math.min(1, amount))
    this.lureHookX = hookX
    this.lureHookY = hookY
    this.lureActive = active
    this.lureDanceDir = danceDir
  }

  /** Spawn extra fish near the hook as lure progress climbs. */
  spawnLureFish(hookX: number, hookY: number, def: FishDef, count = 1): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.6
      const dist = 40 + Math.random() * 50
      const x = hookX + Math.cos(angle) * dist
      let y = hookY + Math.sin(angle) * dist * 0.35
      y = this.clampFishAboveSeabed(x, y)
      const fish = this.makeFish(def, x, y)
      fish.vx = 0
      fish.homeY = y
      this.container.addChild(fish.graphic)
      this.fish.push(fish)
    }
  }

  /**
   * Spawn an immediate burst of fresh fish near the SURFACE. Used at
   * FRENZY START so the screen visibly fills up with dancing fish
   * rather than waiting on the slow ambient trickle.
   */
  triggerFrenzyBurst(count = 10): void {
    const { waterLineY, maxDepth, width } = this.viewport
    // Hard cap so back-to-back frenzies don't accumulate hundreds of
    // fish over a long run.
    const hardCap = 50
    const slots = Math.max(0, hardCap - this.fish.length)
    const toSpawn = Math.min(count, slots)
    // Frenzy is a "showcase" moment — we deliberately over-weight rare
    // and epic species so the player gets a tantalising glimpse of fish
    // they don't normally see in the casual ambient school. Roughly:
    //   common      40%
    //   uncommon    25%
    //   rare        20%
    //   epic        10%
    //   legendary    5%
    const rarityWeight: Record<string, number> = {
      common: 40,
      uncommon: 25,
      rare: 20,
      epic: 10,
      legendary: 5,
    }
    // 70 % of the burst is SMALL fish at the shallow band (they'll
    // surface and dance). The remaining 30 % are BIG fish parked at
    // their natural depth — those are the ones that will perform the
    // size-aware "vertical bob" choreography, giving the player both
    // halves of the show without depending on whatever big fish
    // happened to be in the ambient school when frenzy fired.
    const shallowSpawns = Math.round(toSpawn * 0.7)
    const deepSpawns = toSpawn - shallowSpawns

    for (let i = 0; i < shallowSpawns; i += 1) {
      // Force-shallow depth so the fish dances at the surface.
      const shallowDepth = Math.random() * 0.35
      const candidates = FISH_CATALOG.filter(
        (def) => shallowDepth >= def.minDepth && shallowDepth <= def.maxDepth,
      )
      const def = candidates.length > 0
        ? weightedPick(candidates, (d) => rarityWeight[d.rarity] ?? 10)
        : FISH_CATALOG[0]
      const fromLeft = Math.random() < 0.5
      const x = fromLeft ? -30 : width + 30
      const y = waterLineY + 30 + shallowDepth * (maxDepth - 46)
      const fish = this.makeFish(def, x, y)
      fish.vx = (fromLeft ? 1 : -1) * (35 + Math.random() * 35)
      fish.homeY = y
      this.container.addChild(fish.graphic)
      this.fish.push(fish)
    }
    // Deep-band burst: pick only large/huge species so the bottom
    // half of the screen visibly comes alive with bobbing big fish.
    const bigCandidates = FISH_CATALOG.filter(
      (def) => def.size === 'large' || def.size === 'huge',
    )
    for (let i = 0; i < deepSpawns; i += 1) {
      const def = bigCandidates.length > 0
        ? weightedPick(bigCandidates, (d) => rarityWeight[d.rarity] ?? 10)
        : FISH_CATALOG[0]
      // Pick a depth inside the chosen species' natural band.
      const depth = def.minDepth + Math.random() * (def.maxDepth - def.minDepth)
      const fromLeft = Math.random() < 0.5
      const x = fromLeft ? -30 : width + 30
      const y = waterLineY + 30 + depth * (maxDepth - 46)
      const fish = this.makeFish(def, x, y)
      // Big fish swim a bit more deliberately than the surface dancers.
      fish.vx = (fromLeft ? 1 : -1) * (22 + Math.random() * 24)
      fish.homeY = y
      this.container.addChild(fish.graphic)
      this.fish.push(fish)
    }
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    for (const f of this.fish) {
      // Re-clamp Y to remain in the available depth column on resize
      const minY = viewport.waterLineY + 12
      const maxY = viewport.waterLineY + viewport.maxDepth - 12
      if (f.y < minY) f.y = minY
      if (f.y > maxY) f.y = maxY
    }
  }

  update(dtSeconds: number, hungerIntensity: number): void {
    this.spawnAccumulator += dtSeconds
    // Frenzy boosts both the school cap AND the per-spawn frequency so
    // the screen visibly fills with celebrating fish for a few seconds
    // after the burst triggers.
    const target = 8 + Math.floor(hungerIntensity * 12) + Math.floor(this.frenzyT * 14)
    const spawnInterval = this.frenzyT > 0.4 ? 0.25 : 0.8
    if (this.spawnAccumulator > spawnInterval && this.fish.length < target) {
      this.spawn(hungerIntensity)
      this.spawnAccumulator = 0
    }
    // Surfaces fish target their personal "shallow lane" near the
    // waterline; otherwise they sit at their natural depth. We blend
    // toward the surface position by `frenzyT` so it eases in/out.
    const surfaceLine = this.viewport.waterLineY + 18
    // Beat-driven dance: a single sine wave shared by every fish (with
    // per-fish phase offset). 2π per beat → fish sway left-then-right
    // once per beat, so the school visibly "salsa"s with the music.
    const beatSwing = Math.sin(this.beatPhase * Math.PI * 2)
    const lureRadius = 50 + this.lureGather * 120
    for (let i = this.fish.length - 1; i >= 0; i -= 1) {
      const f = this.fish[i]
      const wagSpeed = 4 + this.frenzyT * 10 + this.lureGather * 6
      f.phase += dtSeconds * wagSpeed
      const horiz = f.vx * (1 + this.frenzyT * 0.6)
      f.x += horiz * dtSeconds

      if (this.lureActive && this.lureGather > 0.05) {
        const dx = this.lureHookX - f.x
        const dy = this.lureHookY - f.y
        const dist = Math.hypot(dx, dy)
        const pull = Math.min(1, this.lureGather * (dist < lureRadius * 2 ? 1.2 : 0.35))
        f.x += dx * pull * dtSeconds * (2.2 + this.lureGather * 2)
        f.y += dy * pull * dtSeconds * 1.6
        f.homeY += (this.lureHookY - f.homeY) * pull * dtSeconds * 0.8
        if (dist < lureRadius * 1.4) {
          f.vx *= 0.92
        }
      }

      // ---- Frenzy choreography depends on the fish's size class ----
      //
      // Small fish (tiny/small)  → surge to the surface to dance.
      // Medium fish              → drift toward a slightly-raised
      //                             "mid-water" lane and sway.
      // Large/huge fish          → STAY at their natural deep home,
      //                             and bob vertically on the beat
      //                             (too big to leap, so they "breach"
      //                             rhythmically in place instead).
      const danceAtSurface = DANCES_AT_SURFACE[f.def.size]
      const bigFish = f.def.size === 'large' || f.def.size === 'huge'
      let targetY: number
      if (danceAtSurface) {
        // Small fish — pull to the surface lane during frenzy.
        const surfaceY = surfaceLine + ((f.x * 0.03) % 14)
        targetY = f.homeY + (surfaceY - f.homeY) * this.frenzyT
      } else if (bigFish) {
        // Big fish — stay deep. Just hold their natural home Y; the
        // beat bob below will lift/drop them rhythmically.
        targetY = f.homeY
      } else {
        // Medium — drift to a shallower lane (about 40 % of the way
        // toward the surface) so they're visible but don't crowd the
        // dancing small fish.
        const midLane = surfaceLine + 60 + ((f.x * 0.04) % 24)
        targetY = f.homeY + (midLane - f.homeY) * this.frenzyT * 0.6
      }
      f.y += (targetY - f.y) * Math.min(1, dtSeconds * 3.2)
      const beatWag = Math.sin((this.beatPhase + f.phase * 0.05) * Math.PI * 2)
      const idleBob = Math.sin(f.phase) * 0.4
      f.y += (idleBob + beatWag * 1.2 * this.frenzyT) * dtSeconds * 60 * 0.06
      f.y = this.clampFishAboveSeabed(f.x, f.y)

      const offscreenLeft = horiz < 0 && f.x < -40
      const offscreenRight = horiz > 0 && f.x > this.viewport.width + 40
      if (offscreenLeft || offscreenRight) {
        f.graphic.destroy()
        this.fish.splice(i, 1)
        continue
      }

      // Frenzy SWAY: visual-only X offset (not f.x) so the swing wraps
      // around the fish's current swim position and doesn't interfere
      // with offscreen detection or the biter handoff. Each fish gets
      // a per-fish phase offset (danceOffset) so the school moves
      // poly-rhythmically, not in lockstep.
      const swayX =
        Math.sin(this.beatPhase * Math.PI * 2 + f.danceOffset) *
        (14 * this.frenzyT + 22 * this.lureGather) *
        this.lureDanceDir

      // ---- Pose computation per fish size ----
      const atSurface = Math.abs(f.y - surfaceLine) < 30
      // Only TINY/SMALL fish stand on their tails — anything bigger
      // looks absurd flipping vertical.
      const standingT = atSurface && danceAtSurface
        ? Math.max(0, Math.min(1, (this.frenzyT - 0.4) / 0.4))
        : 0

      // Per-fish jump cycle: phase-offset so the school staggers,
      // creating a Mexican-wave-style synchronised swim routine.
      let jumpY = 0
      let standingTilt = 0
      if (standingT > 0) {
        const cyc = (this.beatPhase + f.danceOffset / (Math.PI * 2)) % 1
        const jumpHeight = Math.max(0, Math.sin(cyc * Math.PI))
        jumpY = -jumpHeight * 38 * standingT
        standingTilt = Math.sin(this.beatPhase * Math.PI * 2 + f.danceOffset) * 0.32
      }

      // BIG-FISH vertical pulse: a sine-driven bob on each beat. They
      // surge up by ~28 px on the downbeat and sink back as the bar
      // settles. Phase-offset by danceOffset so adjacent big fish
      // don't move in lockstep. The whole effect blends in via
      // frenzyT so the world stays calm outside frenzy.
      let bigFishBob = 0
      if (bigFish && this.frenzyT > 0.1) {
        // Half-cycle "breach" curve: |sin| gives a clean rise+fall
        // per beat, anchored at the home depth.
        const cyc = (this.beatPhase + f.danceOffset / (Math.PI * 2)) % 1
        bigFishBob = -Math.sin(cyc * Math.PI) * 26 * this.frenzyT
      }

      // Idle surface hop (for sub-threshold standingT — still gives some
      // bounce as small fish surface).
      const surfaceHop = atSurface && danceAtSurface
        ? -Math.max(0, beatSwing) * 4 * this.frenzyT * (1 - standingT)
        : 0

      f.graphic.position.set(f.x + swayX, f.y + surfaceHop + jumpY + bigFishBob)
      f.graphic.scale.x = f.vx > 0 ? f.scale : -f.scale

      // ROTATION: blend the normal "horizontal wiggle" pose with the
      // upright "standing on tail" pose. Standing pose is -π/2 for
      // right-facing fish, +π/2 for left-facing (so the HEAD always
      // points UP regardless of swim direction).
      const facing = f.vx >= 0 ? 1 : -1
      const standingRot = (-Math.PI / 2) * facing
      const horizTilt = this.frenzyT * (beatWag * 0.18 + beatSwing * 0.22)
      // Big fish tilt their nose UP on the rising bob, DOWN on the
      // sinking phase — sells the breach as deliberate motion rather
      // than a sprite scrolling on the y axis.
      const bigFishTilt = bigFish ? (bigFishBob / 26) * 0.18 * facing : 0
      f.graphic.rotation =
        horizTilt * (1 - standingT) +
        (standingRot + standingTilt) * standingT +
        bigFishTilt

      // Depth murk: shallow stages show crisp colour; deep stages
      // collapse fish into dark, low-contrast shadows.
      const { waterLineY, maxDepth } = this.viewport
      const fishDepth = Math.max(0, (f.y - waterLineY) / Math.max(1, maxDepth - 40))
      const murk = Math.min(1, this.depthMood * 0.85 + fishDepth * 0.35)
      f.graphic.alpha = 0.95 - murk * 0.55
      const tint = colorMixRgb(0xffffff, 0x0a1420, murk)
      f.graphic.tint = tint
    }

    this.updateSplashes(dtSeconds, surfaceLine)
    this.prevBeatPhase = this.beatPhase
  }

  /**
   * Spawn + advance + render the surface splash particles. A new
   * burst fires every time the beat phase wraps from "near the end"
   * back to "near the start" (downbeat edge), and only when the
   * frenzy intensity is high enough to read visually.
   */
  private updateSplashes(dtSeconds: number, surfaceLine: number): void {
    // Downbeat edge detector: prev was late in beat, current is fresh.
    // Tolerates dropped frames (large dt) by also firing whenever
    // beatPhase jumps backwards.
    const isDownbeat =
      (this.prevBeatPhase > 0.6 && this.beatPhase < 0.4) ||
      this.beatPhase < this.prevBeatPhase - 0.5
    if (isDownbeat && this.frenzyT > 0.3) {
      // Spawn 1 splash per surfaced fish, plus a couple of "free"
      // splashes at random screen positions so even thin schools look
      // like the whole ocean is celebrating.
      let spawned = 0
      for (const f of this.fish) {
        if (Math.abs(f.y - surfaceLine) < 30) {
          this.splashes.push({
            x: f.x + (Math.random() - 0.5) * 12,
            y: surfaceLine,
            t: 1,
            rMax: 14 + Math.random() * 10,
          })
          spawned += 1
          if (spawned >= 8) break
        }
      }
      const freebies = 2 + Math.floor(this.frenzyT * 3)
      for (let i = 0; i < freebies; i += 1) {
        this.splashes.push({
          x: Math.random() * this.viewport.width,
          y: surfaceLine,
          t: 1,
          rMax: 12 + Math.random() * 12,
        })
      }
    }

    for (const s of this.splashes) s.t -= dtSeconds * 2.2
    this.splashes = this.splashes.filter((s) => s.t > 0)
    // Hard cap so a long frenzy can't slowly accumulate particles.
    if (this.splashes.length > 80) {
      this.splashes.splice(0, this.splashes.length - 80)
    }

    // Render all splashes in one batched Graphics pass.
    const g = this.splashGraphics
    g.clear()
    for (const s of this.splashes) {
      const t01 = 1 - s.t // 0..1 expansion progress
      const r = s.rMax * (0.4 + 0.6 * t01)
      const alpha = s.t * 0.9
      // Outer ring on the water surface.
      g.ellipse(s.x, s.y, r, r * 0.35)
      g.stroke({ color: 0xffffff, width: 2, alpha })
      // Inner foam blob.
      g.ellipse(s.x, s.y, r * 0.55, r * 0.18)
      g.fill({ color: 0xfff7c0, alpha: alpha * 0.7 })
      // Two/three water droplets arcing upward + outward.
      const dropCount = 3
      for (let i = 0; i < dropCount; i += 1) {
        const angle = -Math.PI / 2 + ((i - (dropCount - 1) / 2) * 0.55)
        const dist = (1 - s.t) * (s.rMax * 1.4)
        // Parabolic Y: rises then falls. apex at t=0.5.
        const apex = Math.sin(t01 * Math.PI)
        const dx = Math.cos(angle) * dist
        const dy = Math.sin(angle) * dist * 0.45 - apex * s.rMax * 0.8
        g.circle(s.x + dx, s.y + dy, 1.8 + s.t * 1.4)
        g.fill({ color: 0xffffff, alpha })
      }
    }
  }

  /**
   * Pick a fish near the hook to be the biter. Returns the chosen
   * ambient fish (for visual highlight) along with its def.
   */
  pickNearestFish(hookX: number, hookY: number, maxDistance = 220): { fish: AmbientFish; def: FishDef } | null {
    let best: AmbientFish | null = null
    let bestDist = Infinity
    for (const f of this.fish) {
      const d = Math.hypot(f.x - hookX, f.y - hookY)
      if (d < bestDist && d < maxDistance) {
        best = f
        bestDist = d
      }
    }
    if (!best) return null
    return { fish: best, def: best.def }
  }

  /** Remove a specific fish (e.g. when caught or escaped). */
  remove(fish: AmbientFish): void {
    const index = this.fish.indexOf(fish)
    if (index >= 0) {
      fish.graphic.destroy()
      this.fish.splice(index, 1)
    }
  }

  /** Force-spawn one fish near the hook (used when no fish are close). */
  spawnNear(hookX: number, hookY: number, def: FishDef): { fish: AmbientFish; def: FishDef } {
    const fish = this.makeFish(def, hookX + (Math.random() < 0.5 ? -1 : 1) * (60 + Math.random() * 60), hookY)
    this.container.addChild(fish.graphic)
    this.fish.push(fish)
    return { fish, def }
  }

  /** Drive a single fish (used during battle "follow fish"). */
  moveFish(fish: AmbientFish, dx: number, dy: number): void {
    fish.x += dx
    fish.y += dy
    const minY = this.viewport.waterLineY + 12
    const maxY = this.viewport.waterLineY + this.viewport.maxDepth - 12
    if (fish.x < 20) fish.x = 20
    if (fish.x > this.viewport.width - 20) fish.x = this.viewport.width - 20
    if (fish.y < minY) fish.y = minY
    if (fish.y > maxY) fish.y = maxY
    // Render at swim position PLUS the transient tug offset so the
    // hooked fish lurches toward the rod on each beat. The tug never
    // touches fish.x/y, so the clamps above and the fight path stay
    // authoritative.
    fish.graphic.position.set(fish.x + fish.tugX, fish.y + fish.tugY)
    // The school's own update() set rotation from the swim/dance pose
    // earlier this frame; layer the thrash on top of it.
    fish.graphic.rotation += fish.tugRot
  }

  /**
   * Set the transient "tug" displacement + thrash on a hooked fish.
   * Called by BattleState every frame; the offset is applied the next
   * time {@link moveFish} renders the fish. Values are visual-only.
   */
  setFishTug(fish: AmbientFish, offsetX: number, offsetY: number, rot: number): void {
    fish.tugX = offsetX
    fish.tugY = offsetY
    fish.tugRot = rot
  }

  private spawn(hungerIntensity: number): void {
    const { waterLineY, maxDepth, width } = this.viewport
    let depthBand = Math.random()
    depthBand = Math.min(1, depthBand + hungerIntensity * 0.25 * Math.random())
    const candidates = fishEligibleForZone(this.stageZone, depthBand)
    const def =
      candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : FISH_CATALOG[0]
    const fromLeft = Math.random() < 0.5
    const x = fromLeft ? -30 : width + 30
    let y = waterLineY + 30 + depthBand * (maxDepth - 46)
    y = this.clampFishAboveSeabed(x, y)
    const fish = this.makeFish(def, x, y)
    fish.vx = (fromLeft ? 1 : -1) * (18 + Math.random() * 30)
    fish.homeY = y
    this.container.addChild(fish.graphic)
    this.fish.push(fish)
  }

  /** Keep fish in the water column above the sloping sand — never on the beach. */
  private clampFishAboveSeabed(x: number, y: number): number {
    const { width, waterLineY, maxDepth } = this.viewport
    const bed = seabedY(x, width, waterLineY, maxDepth, this.depthMood, this.scrollPx)
    const minY = waterLineY + 16
    const maxY = Math.min(waterLineY + maxDepth - 14, bed - 20)
    if (maxY < minY + 8) return minY
    return Math.max(minY, Math.min(maxY, y))
  }

  private makeFish(def: FishDef, x: number, y: number): AmbientFish {
    const g = new Graphics()
    // Scale comes from the explicit physical size class (which is the
    // contract the catalog promises) rather than rarity — a rare TUNA
    // and a rare RAY are both big without being equally big.
    const scale = SIZE_SCALE[def.size]
    drawFishByShape(g, def)
    g.position.set(x, y)
    g.scale.set(scale, scale)
    return {
      def,
      graphic: g,
      x,
      y,
      vx: 0,
      scale,
      phase: Math.random() * Math.PI * 2,
      homeY: y,
      danceOffset: Math.random() * Math.PI * 2,
      tugX: 0,
      tugY: 0,
      tugRot: 0,
    }
  }
}

/**
 * Render a fish into `g` based on its `bodyShape`. Each branch lives
 * in its own helper so the silhouettes stay readable and easy to
 * iterate on.
 *
 * All shapes are drawn facing RIGHT (head at +x); FishSchool flips
 * scale.x at render time when the fish is swimming left.
 */
function drawFishByShape(g: Graphics, def: FishDef): void {
  g.clear()
  switch (def.bodyShape) {
    case 'slim':
      drawSlimFish(g, def.color)
      break
    case 'torpedo':
      drawTorpedoFish(g, def.color, def.id === 'swordfish')
      break
    case 'round':
      drawRoundFish(g, def.color, def.id === 'pufferfish')
      break
    case 'chunky':
      drawChunkyFish(g, def.color)
      break
    case 'tentacle':
      drawTentacleFish(g, def.color)
      break
    case 'flat':
      drawFlatFish(g, def.color)
      break
    case 'arrow':
      drawArrowFish(g, def.color)
      break
    case 'bell':
      drawBellFish(g, def.color)
      break
  }
}

/**
 * Pick one item from `items` with probability proportional to
 * `weight(item)`. Returns `items[0]` on zero total weight (defensive).
 */
function weightedPick<T>(items: readonly T[], weight: (item: T) => number): T {
  let total = 0
  for (const it of items) total += Math.max(0, weight(it))
  if (total <= 0) return items[0]
  let r = Math.random() * total
  for (const it of items) {
    r -= Math.max(0, weight(it))
    if (r <= 0) return it
  }
  return items[items.length - 1]
}

// ============================================================================
// drawFishByShape helpers
// ============================================================================

function colorMixRgb(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

/**
 * The classic sardine/mackerel shape — a thin streamlined oval with a
 * simple forked tail. Default that the rest of the codebase has
 * trusted for ages.
 */
function drawSlimFish(g: Graphics, color: number): void {
  // Tail
  g.poly([-10, 0, -18, -6, -18, 6])
  g.fill(color)
  // Body
  g.ellipse(0, 0, 12, 6)
  g.fill(color)
  // Belly
  g.ellipse(0, 2, 9, 3)
  g.fill({ color: 0xffffff, alpha: 0.4 })
  // Eye
  g.circle(7, -2, 1.2)
  g.fill(0xffffff)
  g.circle(7, -2, 0.6)
  g.fill(0x000000)
  // Dorsal fin
  g.poly([-2, -4, 2, -4, 0, -8])
  g.fill({ color, alpha: 0.8 })
}

/**
 * Tuna/swordfish silhouette — longer, fatter oval with a crescent
 * tail. Passing `isSwordfish=true` adds the long thin bill extending
 * from the nose so the species reads even before colour registers.
 */
function drawTorpedoFish(g: Graphics, color: number, isSwordfish: boolean): void {
  // Long body
  g.ellipse(0, 0, 16, 7)
  g.fill(color)
  // Belly highlight
  g.ellipse(0, 2.5, 12, 3.2)
  g.fill({ color: 0xffffff, alpha: 0.35 })
  // Crescent tail — two notched triangles.
  g.poly([-14, 0, -24, -8, -19, 0, -24, 8])
  g.fill(color)
  // Dorsal fin
  g.poly([-3, -6, 3, -6, 0, -11])
  g.fill({ color, alpha: 0.85 })
  // Pectoral fin underneath, sweeping back.
  g.poly([2, 4, -2, 7, 6, 4])
  g.fill({ color, alpha: 0.7 })
  // Eye
  g.circle(11, -2, 1.4)
  g.fill(0xffffff)
  g.circle(11, -2, 0.7)
  g.fill(0x000000)
  if (isSwordfish) {
    // Long thin bill spearing forward from the nose. Stroked with a
    // slight darker tone so it reads against the body colour.
    g.moveTo(16, 0)
    g.lineTo(34, -1)
    g.stroke({ color: 0xeae0c8, width: 2, cap: 'round' })
    g.moveTo(16, 0)
    g.lineTo(34, -1)
    g.stroke({ color: 0x44352a, width: 1, cap: 'round', alpha: 0.35 })
  }
}

/**
 * Disc-shaped body. Used for moonfish (smooth) and pufferfish (with
 * spikes around the rim).
 */
function drawRoundFish(g: Graphics, color: number, isPuffer: boolean): void {
  // Main disc
  g.circle(0, 0, 11)
  g.fill(color)
  // Belly lighter half
  g.ellipse(0, 3, 8, 5)
  g.fill({ color: 0xffffff, alpha: 0.35 })
  if (isPuffer) {
    // Spike ring — 10 short triangles radiating out. Skip the right
    // quadrant so the eye still reads.
    const spikes = 10
    for (let i = 0; i < spikes; i += 1) {
      const a = (i / spikes) * Math.PI * 2
      if (a > -0.4 && a < 0.6) continue
      const inner = 10
      const outer = 14
      const baseHalf = 1.4
      const cx = Math.cos(a)
      const cy = Math.sin(a)
      const px = -cy
      const py = cx
      g.poly([
        cx * outer, cy * outer,
        cx * inner + px * baseHalf, cy * inner + py * baseHalf,
        cx * inner - px * baseHalf, cy * inner - py * baseHalf,
      ])
      g.fill({ color, alpha: 0.85 })
    }
  } else {
    // Smooth disc — small dorsal + ventral fins on top/bottom (the
    // moonfish profile).
    g.poly([0, -10, 5, -16, -3, -16])
    g.fill({ color, alpha: 0.8 })
    g.poly([0, 10, 5, 16, -3, 16])
    g.fill({ color, alpha: 0.8 })
  }
  // Small tail nub on the left.
  g.poly([-11, 0, -16, -4, -16, 4])
  g.fill({ color, alpha: 0.9 })
  // Eye
  g.circle(7, -2, 1.4)
  g.fill(0xffffff)
  g.circle(7, -2, 0.7)
  g.fill(0x000000)
}

/**
 * Wide chunky body with a big mouth — the anglerfish profile. The
 * dangling lure on a stalk above the head is the diagnostic feature.
 */
function drawChunkyFish(g: Graphics, color: number): void {
  // Wide body
  g.ellipse(0, 0, 14, 9)
  g.fill(color)
  // Slightly lighter cheek
  g.ellipse(2, 3, 10, 4)
  g.fill({ color: 0xffffff, alpha: 0.18 })
  // Tail — short fan.
  g.poly([-12, 0, -20, -7, -20, 7])
  g.fill(color)
  // Dorsal spines (3 small triangles)
  for (let i = -4; i <= 4; i += 4) {
    g.poly([i - 1, -8, i + 1, -8, i, -13])
    g.fill({ color, alpha: 0.85 })
  }
  // Wide grinning mouth — dark crescent across the front.
  g.moveTo(2, 2)
  g.quadraticCurveTo(10, 5, 14, 2)
  g.stroke({ color: 0x140005, width: 2, cap: 'round' })
  // Sharp tooth row hinted with tiny upward triangles inside the mouth.
  for (let i = 4; i < 14; i += 3) {
    g.poly([i, 2, i + 1.2, 2, i + 0.6, 0.5])
    g.fill({ color: 0xfff5d0, alpha: 0.9 })
  }
  // Eye — bigger, with a manic small pupil.
  g.circle(8, -3, 2)
  g.fill(0xffffff)
  g.circle(9, -2.5, 0.9)
  g.fill(0x000000)
  // Stalk + bioluminescent lure dangling above the head.
  g.moveTo(2, -8)
  g.quadraticCurveTo(8, -16, 14, -12)
  g.stroke({ color: 0x202020, width: 1.2, cap: 'round' })
  g.circle(14, -12, 2.2)
  g.fill({ color: 0xfff088, alpha: 0.95 })
  g.circle(14, -12, 1.1)
  g.fill({ color: 0xfff5d0, alpha: 1 })
}

/**
 * Small body with multiple drooping tentacles — krakenling silhouette.
 */
function drawTentacleFish(g: Graphics, color: number): void {
  // Mantle / head
  g.ellipse(0, -2, 11, 8)
  g.fill(color)
  // Belly highlight
  g.ellipse(0, 0, 8, 5)
  g.fill({ color: 0xffffff, alpha: 0.22 })
  // Eye (big alien eye on the side).
  g.circle(7, -3, 2.4)
  g.fill(0xfff5d0)
  g.rect(7 - 0.6, -3 - 2.4, 1.2, 4.8)
  g.fill(0x140005)
  // Tentacles — 5 wavy strands hanging down.
  const tentX = [-8, -4, 0, 4, 8]
  for (const tx of tentX) {
    g.moveTo(tx, 4)
    g.quadraticCurveTo(tx + 2, 9, tx - 1, 13)
    g.quadraticCurveTo(tx - 3, 17, tx + 1, 20)
    g.stroke({ color, width: 2.4, cap: 'round' })
    // Suckers (small dots along the inner side).
    for (let s = 6; s <= 18; s += 4) {
      g.circle(tx + Math.sin(s * 0.5) * 1.5, s, 0.7)
      g.fill({ color: 0xffffff, alpha: 0.5 })
    }
  }
}

/**
 * Manta-ray silhouette: flat horizontal diamond/kite shape with two
 * forward-curving "horns" and a long whip tail trailing behind.
 */
function drawFlatFish(g: Graphics, color: number): void {
  // Diamond body — long horizontally, slim vertically.
  g.poly([-16, 0, 0, -7, 18, 0, 0, 7])
  g.fill(color)
  // Belly highlight — thin ellipse along the underside.
  g.ellipse(2, 3, 12, 1.6)
  g.fill({ color: 0xffffff, alpha: 0.25 })
  // Wing tips bulging out (gives a hint of cape spread).
  g.ellipse(-12, 0, 5, 5)
  g.fill({ color, alpha: 0.85 })
  // Forward "horns" (cephalic fins curving in front of the head).
  g.moveTo(14, -2)
  g.quadraticCurveTo(22, -6, 26, -3)
  g.stroke({ color, width: 2, cap: 'round' })
  g.moveTo(14, 2)
  g.quadraticCurveTo(22, 6, 26, 3)
  g.stroke({ color, width: 2, cap: 'round' })
  // Tiny eye on top.
  g.circle(8, -3, 1.2)
  g.fill(0xffffff)
  g.circle(8, -3, 0.5)
  g.fill(0x000000)
  // Long whip tail trailing left.
  g.moveTo(-16, 0)
  g.quadraticCurveTo(-22, 2, -32, -1)
  g.stroke({ color, width: 1.5, cap: 'round' })
}

/**
 * Shrimp/krill silhouette — small segmented arrow with antennae out
 * front and a fan tail at the rear.
 */
function drawArrowFish(g: Graphics, color: number): void {
  // Segmented curved body — 4 small ellipses.
  for (let i = 0; i < 4; i += 1) {
    const x = -6 + i * 4
    g.ellipse(x, 0, 3.2, 3.4)
    g.fill({ color, alpha: 0.85 + i * 0.04 })
  }
  // Head bump on the right.
  g.ellipse(8, 0, 3.4, 3)
  g.fill(color)
  // Tail fan on the left — three small triangles.
  g.poly([-7, 0, -12, -3, -10, 0, -12, 3])
  g.fill(color)
  // Antennae — two thin curves projecting forward.
  g.moveTo(11, -1)
  g.quadraticCurveTo(16, -4, 20, -3)
  g.stroke({ color: 0x140005, width: 0.7, cap: 'round' })
  g.moveTo(11, 1)
  g.quadraticCurveTo(16, 4, 20, 3)
  g.stroke({ color: 0x140005, width: 0.7, cap: 'round' })
  // Two little legs / swimmerets underneath.
  for (let i = 0; i < 3; i += 1) {
    const x = -3 + i * 3
    g.moveTo(x, 3)
    g.lineTo(x - 1, 6)
    g.stroke({ color: 0x140005, width: 0.7, cap: 'round' })
  }
  // Eye — black bead near the head.
  g.circle(10, -1, 1)
  g.fill(0x000000)
}

/**
 * Jellyfish — translucent dome on top with wavy strands hanging
 * down. The body alpha is set lower than other fish so it reads as
 * see-through against the water.
 */
function drawBellFish(g: Graphics, color: number): void {
  // Bell dome — half-ellipse on top, opaque enough to read.
  g.ellipse(0, -2, 11, 7)
  g.fill({ color, alpha: 0.78 })
  // Lighter inner glow on top.
  g.ellipse(0, -4, 8, 3.5)
  g.fill({ color: 0xffffff, alpha: 0.35 })
  // Bell rim (flat bottom of the dome) — small dark ellipse.
  g.ellipse(0, 4, 11, 1.4)
  g.fill({ color, alpha: 0.6 })
  // Hanging strands — 5 wavy lines descending.
  const strandX = [-7, -3, 0, 3, 7]
  for (const sx of strandX) {
    g.moveTo(sx, 5)
    g.quadraticCurveTo(sx + 2, 10, sx - 1, 15)
    g.quadraticCurveTo(sx - 3, 19, sx + 2, 23)
    g.stroke({ color, width: 1.2, cap: 'round', alpha: 0.85 })
  }
  // Two shorter frilly tentacles in the middle.
  for (const sx of [-2, 2]) {
    g.moveTo(sx, 5)
    g.quadraticCurveTo(sx + 1, 8, sx - 0.5, 11)
    g.stroke({ color: 0xffffff, width: 1, cap: 'round', alpha: 0.7 })
  }
}

/**
 * Legacy export kept for any callers that still want a generic fish
 * silhouette without a FishDef. Delegates to the slim-body painter.
 */
export function drawFish(g: Graphics, color: number): void {
  g.clear()
  drawSlimFish(g, color)
}

export type { AmbientFish }
