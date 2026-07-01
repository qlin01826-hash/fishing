import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { BeatClock } from '../systems/BeatClock'
import type { TapJudgement } from './PullPanel'

interface LaneNote {
  /** Fractional beat index — supports off-beats (e.g. 5.5, 7.25). */
  beatIndex: number
  graphic: Graphics
  state: 'live' | 'hit' | 'missed'
  judgement: TapJudgement | null
  /** Animation timer once the note transitions out of 'live'. */
  effectT: number
  /** Whether this note sits on a downbeat (1/4) or off-beat (1/8, 1/16). */
  weight: 'down' | 'off' | 'ghost'
  /** Required steer direction for this note: -1 left, 0 centre tap, +1 right. */
  dir: number
}

/**
 * Per-intensity rhythm patterns over an 8-slot bar (one slot = 1/8 note).
 *
 *   slot:  0    1    2    3    4    5    6    7
 *   beat:  1   1.5    2   2.5   3   3.5   4   4.5
 *
 * `'D'`/`'o'`/`'g'` marks a slot that spawns a note (with that visual
 * weight). `'.'` means no note. Difficulty is curated so the player
 * feels a clear ramp:
 *
 *   L0 (intro)     : only beats 1 and 3 — half-note pulse. Player
 *                     barely needs to engage; sets the metronome.
 *   L1 (verse)     : every quarter note (1, 2, 3, 4). The "classic
 *                     four-on-the-floor" feel — you tap with the kick.
 *   L2 (preChorus) : adds the &-of-2 and &-of-4 accents on top of the
 *                     four quarters — pushes into syncopation.
 *   L3 (chorus)    : full eighth-note groove + ghost taps on the
 *                     &-of-1 and &-of-3 for the busy chorus.
 *
 * The number of taps per bar progresses 2 → 4 → 6 → 8, which is the
 * "simple → add accents → faster + more accents" curve the design
 * asked for.
 */
const PATTERNS: ReadonlyArray<ReadonlyArray<'.' | 'D' | 'o' | 'g'>> = [
  // L0 intro — 2 notes per bar (beats 1 and 3).
  ['D', '.', '.', '.', 'D', '.', '.', '.'],
  // L1 verse — 4 quarter notes, no offbeats yet.
  ['D', '.', 'D', '.', 'D', '.', 'D', '.'],
  // L2 preChorus — 6 notes per bar: quarters + accents on &-of-2 and &-of-4.
  ['D', '.', 'D', 'o', 'D', '.', 'D', 'o'],
  // L3 chorus — 8 notes per bar: full 1/8 groove with ghost taps on &-of-1, &-of-3.
  ['D', 'g', 'D', 'o', 'D', 'g', 'D', 'o'],
]

const PATTERN_SLOT_COUNT = 8 // 8 eighth-notes in a 4-beat bar

interface Particle {
  graphic: Graphics
  vx: number
  vy: number
  life: number
  totalLife: number
}

/**
 * Horizontal rhythm-game note lane.
 *
 * Notes spawn at the right end of the lane and flow leftward toward a
 * fixed hit zone at `hitX`. The hit zone visually coincides with the
 * {@link PullPanel} centre so the player's eye tracks every beat as it
 * approaches the tap target.
 *
 * Each beat (driven by {@link BeatClock}) spawns one note. The owner
 * forwards every PullPanel tap into {@link registerTap}; the lane then
 * finds the nearest live note within ±`hitWindowMs`, marks it hit, and
 * spawns a small particle burst whose colour matches the timing
 * judgement.
 *
 * Notes that pass the hit zone without being consumed are auto-missed.
 * Consecutive auto-misses are exposed via {@link consecutiveAutoMisses}
 * so the battle layer can drive the "fish struggles" state.
 *
 * The lane intentionally does NOT decide game outcomes — it's purely a
 * timing/visual surface. BattleState reads its counters and judgements
 * and decides what they mean for tension/willpower.
 */
export class NoteLane {
  readonly container = new Container()

  private readonly track = new Graphics()
  private readonly hitZone = new Graphics()
  private readonly noteLayer = new Container()
  private readonly effectLayer = new Container()
  private readonly missText: Text

  private notes: LaneNote[] = []
  private particles: Particle[] = []
  /**
   * Next slot index in the global eighth-note grid that the spawner
   * will consider. Each integer step is 1/8 of a quarter beat, so
   * `slotToBeatIndex(slot) = slot / 2`.
   */
  private nextSpawnSlot = 0
  /** True once `attachBeatClock` has run and the clock has fired its first frame. */
  private active = false

  /** Counts consecutive auto-missed notes. Reset whenever a hit lands. */
  consecutiveAutoMisses = 0

  /** 0..(PATTERNS-1) — picked from {@link PATTERNS}. Driven externally by BattleState. */
  private intensity = 0
  /**
   * Stage-driven clamp on {@link intensity}. The progression stage sets
   * these so low stages stay sparse (gentle on-ramp) and deep stages
   * never drop to a trivial chart. Defaults span the full pattern range.
   */
  private densityFloor = 0
  private densityCap = PATTERNS.length - 1

  private beatClock: BeatClock | null = null

  /**
   * Optional per-beat steer-direction source. BattleState wires this to
   * the fish's lateral path so downbeat notes show which way to swipe
   * ("follow the fish"). Returns -1 / 0 / +1.
   */
  private directionProvider: ((beatIndex: number) => number) | null = null

  // Layout
  private hitX = 0
  private laneY = 0
  private laneLength = 360
  /**
   * Beats of look-ahead (notes appear this many beats before their hit
   * moment). Lower = notes arrive later = less reaction time = harder.
   * Stage-driven via {@link setLookAhead}; defaults to the baseline 2.
   */
  private lookAheadBeats = 2

  // Timing window for matching a tap to a note. Must match PullPanel's
  // `goodWindowMs` so the player can never receive a Good judgement
  // that fails to consume the note in front of them.
  private readonly hitWindowMs = 200

  constructor() {
    this.container.addChild(this.track, this.noteLayer, this.hitZone, this.effectLayer)
    this.missText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 14,
        fontFamily: 'Menlo, Consolas, monospace',
        fontWeight: '700',
        fill: '#ff6b6b',
        stroke: { color: 0x000000, width: 3 },
      }),
    })
    this.missText.anchor.set(0.5, 0.5)
    this.missText.alpha = 0
    this.container.addChild(this.missText)
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
  }

  /**
   * Supply a steer-direction source for downbeat notes (-1 / 0 / +1).
   * Pass `null` to fall back to plain centre-tap notes. Set this AFTER
   * {@link start} (start → reset clears it).
   */
  setDirectionProvider(fn: ((beatIndex: number) => number) | null): void {
    this.directionProvider = fn
  }

  setLayout(hitX: number, laneY: number, laneLength: number): void {
    this.hitX = hitX
    this.laneY = laneY
    this.laneLength = laneLength
    this.drawStatic()
  }

  /**
   * Begin spawning notes from the current beat onward. Resets the lane.
   * Call when entering battle.
   */
  start(): void {
    this.reset()
    this.active = true
    if (this.beatClock?.started) {
      // Round up to the next beat boundary and add a one-beat lead-in
      // so the first note never spawns mid-air. We work in slot space
      // where each integer is an eighth-note.
      const nextBeat = this.beatClock.nextBeatAfterPerf(performance.now()) + 1
      this.nextSpawnSlot = nextBeat * 2
    }
  }

  /**
   * Set the rhythm density level (0..3). Higher levels add off-beat
   * notes from {@link PATTERNS}. Safe to call any time — the change
   * takes effect at the next spawn evaluation, no notes are inserted
   * retroactively into the look-ahead window.
   */
  setIntensity(level: number): void {
    const hardMax = PATTERNS.length - 1
    const cap = Math.min(hardMax, this.densityCap)
    const floor = Math.max(0, Math.min(cap, this.densityFloor))
    this.intensity = Math.max(floor, Math.min(cap, Math.round(level)))
  }

  /**
   * Stage-driven density clamp. `floor` keeps deep-water charts from
   * ever going trivially sparse; `cap` keeps the early on-ramp gentle.
   * Re-applies the clamp to the current intensity immediately.
   */
  setDensityRange(floor: number, cap: number): void {
    const hardMax = PATTERNS.length - 1
    this.densityCap = Math.max(0, Math.min(hardMax, Math.round(cap)))
    this.densityFloor = Math.max(0, Math.min(this.densityCap, Math.round(floor)))
    // Re-clamp the live intensity to the new range.
    this.setIntensity(this.intensity)
  }

  /**
   * Set note look-ahead in beats (reaction-time difficulty lever).
   * Lower values make notes appear later and travel the lane faster.
   * Call AFTER {@link start} — start() resets this to the default, and
   * the value is only consulted in update()'s spawn horizon.
   */
  setLookAhead(beats: number): void {
    this.lookAheadBeats = Math.max(0.75, Math.min(4, beats))
  }

  /** Halt note spawning + clear remaining notes (with a fade). */
  stop(): void {
    this.active = false
    // Fade existing notes out
    for (const note of this.notes) {
      if (note.state === 'live') {
        note.state = 'missed'
        note.effectT = 0.6
      }
    }
  }

  reset(): void {
    this.active = false
    for (const note of this.notes) {
      this.noteLayer.removeChild(note.graphic)
    }
    for (const p of this.particles) {
      this.effectLayer.removeChild(p.graphic)
    }
    this.notes = []
    this.particles = []
    this.consecutiveAutoMisses = 0
    this.intensity = 0
    this.densityFloor = 0
    this.densityCap = PATTERNS.length - 1
    this.lookAheadBeats = 2
    this.nextSpawnSlot = 0
    this.missText.alpha = 0
    this.directionProvider = null
  }

  /**
   * Forward a tap judgement from the PullPanel. The lane finds the
   * nearest live note inside the hit window, marks it consumed, and
   * resets the consecutive-miss counter.
   *
   * Returns the consumed note's judgement, or `null` if the tap landed
   * with no nearby live note (an off-beat phantom tap).
   */
  registerTap(judgement: TapJudgement, nowMs: number, swipeDir = 0): TapJudgement | null {
    if (!this.beatClock?.started || !this.active) return null
    // Off-beat taps (Miss) do not consume notes — they're "wasted" by design,
    // and only auto-misses (beats passed without any tap) feed into struggle.
    if (judgement === 'miss') {
      this.flashMissText('OFF')
      return null
    }
    let best: LaneNote | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const note of this.notes) {
      if (note.state !== 'live') continue
      const beatTime = this.beatClock.perfTimeOfBeat(note.beatIndex)
      const dist = Math.abs(nowMs - beatTime)
      if (dist <= this.hitWindowMs && dist < bestDist) {
        bestDist = dist
        best = note
      }
    }
    if (!best) return null
    // Right time, wrong way: the swipe didn't follow the fish. Mark it as
    // a miss visually so the player sees the steering mistake.
    const wrongDir = best.dir !== 0 && swipeDir !== best.dir
    const shown: TapJudgement = wrongDir ? 'miss' : judgement
    best.state = 'hit'
    best.judgement = shown
    best.effectT = 1
    if (wrongDir) {
      this.flashMissText('WRONG WAY')
    } else {
      this.consecutiveAutoMisses = 0
    }
    this.spawnHitParticles(this.hitX, this.laneY, shown)
    return shown
  }

  update(dtSeconds: number, nowMs: number): void {
    if (!this.beatClock?.started) {
      this.drawStatic()
      return
    }
    // Spawn upcoming notes. The grid is an eighth-note grid (2 slots per
    // quarter beat); we consult the active pattern to decide whether
    // each slot actually carries a note.
    if (this.active) {
      const horizon = nowMs + this.lookAheadBeats * this.beatClock.beatIntervalMs + 50
      const pattern = PATTERNS[this.intensity]
      while (true) {
        const beatIndex = this.nextSpawnSlot / 2
        const beatTime = this.beatClock.perfTimeOfBeat(beatIndex)
        if (beatTime > horizon) break
        const slotInBar = ((this.nextSpawnSlot % PATTERN_SLOT_COUNT) + PATTERN_SLOT_COUNT) % PATTERN_SLOT_COUNT
        const cell = pattern[slotInBar]
        if (cell !== '.') {
          const weight: LaneNote['weight'] = cell === 'D' ? 'down' : cell === 'o' ? 'off' : 'ghost'
          this.spawnNote(beatIndex, weight)
        }
        this.nextSpawnSlot += 1
      }
    }

    const ppm = this.laneLength / (this.lookAheadBeats * this.beatClock.beatIntervalMs)

    for (const note of this.notes) {
      const beatTime = this.beatClock.perfTimeOfBeat(note.beatIndex)
      const remainingMs = beatTime - nowMs
      if (note.state === 'live') {
        const x = this.hitX + remainingMs * ppm
        note.graphic.position.set(x, this.laneY)
        // Notes grow as they approach the hit zone so the impending hit reads strongly.
        const proximity = Math.max(0, 1 - Math.abs(remainingMs) / (this.lookAheadBeats * this.beatClock.beatIntervalMs))
        note.graphic.scale.set(0.7 + proximity * 0.55)
        note.graphic.alpha = 0.4 + proximity * 0.6
        // Auto-miss: passed the hit window without a tap. Only DOWNBEAT
        // notes count toward the consecutive-miss streak; off-beats and
        // ghost notes are optional flavour and missing them never
        // triggers the fish-struggle escalation.
        if (nowMs - beatTime > this.hitWindowMs) {
          note.state = 'missed'
          note.effectT = 1
          if (note.weight === 'down') {
            this.consecutiveAutoMisses += 1
            this.flashMissText('MISS')
          }
        }
      } else if (note.state === 'hit') {
        note.effectT -= dtSeconds * 3
        const grow = 1 - note.effectT
        note.graphic.position.set(this.hitX, this.laneY)
        note.graphic.scale.set(1 + grow * 1.4)
        note.graphic.alpha = Math.max(0, note.effectT)
      } else if (note.state === 'missed') {
        note.effectT -= dtSeconds * 1.5
        // Keep drifting left as it fades + drops slightly so it reads
        // as "slipped past the hit zone".
        const x = this.hitX + (beatTime - nowMs) * ppm
        note.graphic.position.set(x, this.laneY + (1 - note.effectT) * 22)
        note.graphic.alpha = Math.max(0, note.effectT) * 0.6
        note.graphic.scale.set(0.9)
      }
    }

    // Garbage collect spent notes.
    this.notes = this.notes.filter((note) => {
      if (note.state !== 'live' && note.effectT <= 0) {
        this.noteLayer.removeChild(note.graphic)
        return false
      }
      return true
    })

    // Particle update.
    for (const p of this.particles) {
      p.life -= dtSeconds
      const t01 = Math.max(0, p.life / p.totalLife)
      p.graphic.position.x += p.vx * dtSeconds
      p.graphic.position.y += p.vy * dtSeconds
      p.vy += 280 * dtSeconds // gravity pulls particles down slightly
      p.graphic.alpha = t01
      p.graphic.scale.set(0.4 + (1 - t01) * 0.8)
    }
    this.particles = this.particles.filter((p) => {
      if (p.life <= 0) {
        this.effectLayer.removeChild(p.graphic)
        return false
      }
      return true
    })

    // Fade out floating miss text.
    if (this.missText.alpha > 0) {
      this.missText.alpha = Math.max(0, this.missText.alpha - dtSeconds * 1.6)
      this.missText.position.y = this.laneY - 26 - (1 - this.missText.alpha) * 16
    }

    this.drawStatic()
    this.drawHitZone(nowMs)
  }

  private spawnNote(beatIndex: number, weight: LaneNote['weight']): void {
    if (!this.beatClock?.started) return
    const g = new Graphics()
    // Visual weight differentiates downbeats (big yellow), off-beats
    // (smaller blue) and ghosts (smallest, faint blue). Players can read
    // the upcoming pattern density without counting.
    const sizes = { down: 11, off: 8, ghost: 6 } as const
    const outerColors = { down: 0xffd166, off: 0x9fe6ff, ghost: 0x6fbed1 } as const
    const innerColors = { down: 0xfff3c1, off: 0xd9f6ff, ghost: 0xb4dfec } as const
    const outerR = sizes[weight]
    // Only downbeats carry a steer direction; off/ghost stay simple taps.
    const dir = weight === 'down' && this.directionProvider ? this.directionProvider(beatIndex) : 0
    g.circle(0, 0, outerR)
    g.fill({ color: outerColors[weight], alpha: weight === 'ghost' ? 0.65 : 1 })
    g.stroke({ color: 0x000000, width: 2, alpha: weight === 'ghost' ? 0.5 : 0.8 })
    // Inner ring highlight gives the note a "drum-skin" feel.
    g.circle(0, 0, Math.max(3, outerR * 0.55))
    g.fill({ color: innerColors[weight], alpha: 0.9 })
    if (dir !== 0) {
      // Bold chevrons pointing the way to swipe — "follow the fish".
      const base = outerR + 4
      for (let k = 0; k < 2; k += 1) {
        const ox = dir * (base + k * 7)
        g.moveTo(ox, -7)
        g.lineTo(ox + dir * 7, 0)
        g.lineTo(ox, 7)
        g.stroke({ color: 0xffffff, width: 3, alpha: 0.92 })
      }
    }
    this.noteLayer.addChild(g)
    // Pre-position offscreen so the first paint doesn't flicker at (0,0).
    g.position.set(this.hitX + this.laneLength + 30, this.laneY)
    this.notes.push({
      beatIndex,
      graphic: g,
      state: 'live',
      judgement: null,
      effectT: 0,
      weight,
      dir,
    })
  }

  private spawnHitParticles(x: number, y: number, judgement: TapJudgement): void {
    const count = judgement === 'perfect' ? 12 : judgement === 'miss' ? 5 : 7
    const color =
      judgement === 'perfect' ? 0xffd166 : judgement === 'miss' ? 0xff6b6b : 0x9fe6ff
    for (let i = 0; i < count; i += 1) {
      const g = new Graphics()
      g.circle(0, 0, 3 + Math.random() * 2)
      g.fill({ color, alpha: 0.95 })
      g.position.set(x, y)
      this.effectLayer.addChild(g)
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3
      const speed = 110 + Math.random() * 140
      this.particles.push({
        graphic: g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        life: 0.5 + Math.random() * 0.25,
        totalLife: 0.7,
      })
    }
  }

  private flashMissText(label: string): void {
    this.missText.text = label
    this.missText.alpha = 1
    this.missText.position.set(this.hitX, this.laneY - 26)
  }

  private drawStatic(): void {
    const t = this.track
    t.clear()
    // Underline track (faint).
    t.moveTo(this.hitX, this.laneY)
    t.lineTo(this.hitX + this.laneLength, this.laneY)
    t.stroke({ color: 0xffefb0, width: 2, alpha: 0.18 })
    // Tick marks every beat for visual cadence.
    if (this.beatClock?.started) {
      const now = performance.now()
      const ppm = this.laneLength / (this.lookAheadBeats * this.beatClock.beatIntervalMs)
      const startBeat = this.beatClock.nearestBeatIndex(now)
      for (let i = -1; i <= this.lookAheadBeats + 1; i += 1) {
        const beat = startBeat + i
        const beatTime = this.beatClock.perfTimeOfBeat(beat)
        const x = this.hitX + (beatTime - now) * ppm
        if (x < this.hitX - 10 || x > this.hitX + this.laneLength + 10) continue
        const isDownbeat = beat % 4 === 0
        t.moveTo(x, this.laneY - (isDownbeat ? 10 : 6))
        t.lineTo(x, this.laneY + (isDownbeat ? 10 : 6))
        t.stroke({
          color: 0xffefb0,
          width: isDownbeat ? 2 : 1,
          alpha: isDownbeat ? 0.35 : 0.18,
        })
      }
    }
  }

  private drawHitZone(nowMs: number): void {
    // Mobile needs an explicit judgement line: notes are correct when
    // they touch this vertical marker, which sits on the PullPanel centre.
    const g = this.hitZone
    g.clear()
    if (!this.beatClock?.started) return
    const phase = this.beatClock.phase(nowMs)
    const flash = phase < 0.18 ? 1 - phase / 0.18 : 0
    const lineHalf = 54 + flash * 8
    g.moveTo(this.hitX, this.laneY - lineHalf)
    g.lineTo(this.hitX, this.laneY + lineHalf)
    g.stroke({ color: 0xffd166, width: 4, alpha: 0.58 + flash * 0.32 })
    g.circle(this.hitX, this.laneY, 10 + flash * 5)
    g.stroke({ color: 0xffffff, width: 2, alpha: 0.35 + flash * 0.45 })
  }
}
