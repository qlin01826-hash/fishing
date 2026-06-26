import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import type { BeatClock } from '../systems/BeatClock'
import type { FishDef, ViewportContext } from '../types'

type RhythmJudgement = 'perfect' | 'good' | 'miss'
type InputKey = 'space' | 'left' | 'right'
type NoteType = 'tap' | 'hold' | 'arc' | 'dual'
type NoteHeight = 'ground' | 'air'

interface RhythmNote {
  id: string
  beatIndex: number
  durationBeats: number
  type: NoteType
  lane: -1 | 0 | 1
  height: NoteHeight
  state: 'live' | 'hit' | 'missed'
  judgement: RhythmJudgement | null
  head: Graphics
  tail?: Graphics
  curveType?: 'straight' | 'dive' | 'wave' | 'helix'
}

interface Particle {
  graphic: Graphics
  vx: number
  vy: number
  life: number
  totalLife: number
  spin: number
  spinV: number
}

/** Result of a successful tap, so the caller can layer audio per height. */
export interface HitResult {
  judgement: RhythmJudgement
  height: NoteHeight
  type: NoteType
}

/**
 * Immersive pseudo-3D rhythm chart (Arcaea-inspired) covering the whole
 * underwater viewport.
 *
 * Two distinct surfaces:
 * - GROUND track: a receding floor plane near the bottom. Notes are
 *   rectangular "floor tiles". Hits spark an upward dust burst.
 * - AIR/SKY line: an elevated rail. Notes are diamond nodes; arcs draw a
 *   curved ribbon with explicit HEAD and TAIL connection knobs. Hits
 *   spark a radial ring sparkle.
 */
export class RhythmTrack {
  readonly container = new Container()
  private readonly tunnelLayer = new Container()
  private readonly groundLayer = new Container()
  private readonly airLayer = new Container()
  private readonly arcLayer = new Container()
  private readonly noteLayer = new Container()
  private readonly effectLayer = new Container()
  private readonly uiLayer = new Container()

  private readonly groundPlane = new Graphics()
  private readonly airRail = new Graphics()
  private readonly hitCursor = new Graphics()
  private readonly horizonGlow = new Graphics()
  private readonly judgementText: Text
  private readonly comboText: Text

  private viewport: ViewportContext = { width: 1, height: 1, waterLineY: 1, maxDepth: 1 }
  private centerX = 0
  private centerY = 0

  private beatClock: BeatClock | null = null
  private notes: RhythmNote[] = []
  private particles: Particle[] = []
  private activeHolds: Record<InputKey, boolean> = { space: false, left: false, right: false }

  private chartSeed = 1
  private stageIndex = 0
  private nextSpawnBeat = 0
  private textTimer = 0

  // Big, screen-filling perspective constants.
  private readonly Z_HORIZON = 1400
  private readonly Z_HIT = 130
  private readonly FOCAL_LENGTH = 260
  private readonly LANE_SPREAD = 230
  private readonly GROUND_Y = 240
  private readonly AIR_Y = -220
  private readonly WINDOW_PERFECT = 90
  private readonly WINDOW_GOOD = 200
  private readonly LOOK_AHEAD_BEATS = 6

  /** Height of the most recently hit note, so callers can layer SFX. */
  lastHit: HitResult | null = null

  consecutiveMisses = 0
  combo = 0
  maxCombo = 0

  constructor() {
    this.container.addChild(
      this.tunnelLayer,
      this.groundLayer,
      this.airLayer,
      this.arcLayer,
      this.noteLayer,
      this.effectLayer,
      this.uiLayer,
    )
    this.groundLayer.addChild(this.horizonGlow, this.groundPlane)
    this.airLayer.addChild(this.airRail)
    this.uiLayer.addChild(this.hitCursor)

    this.judgementText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 34,
        fontFamily: 'Arial, sans-serif',
        fontWeight: '900',
        fill: '#ffd166',
        stroke: { color: 0x000000, width: 5 },
      }),
    })
    this.judgementText.anchor.set(0.5)
    this.judgementText.alpha = 0

    this.comboText = new Text({
      text: '',
      style: new TextStyle({
        fontSize: 24,
        fontFamily: 'Arial, sans-serif',
        fontWeight: '700',
        fill: '#ffffff',
        stroke: { color: 0x000000, width: 4 },
      }),
    })
    this.comboText.anchor.set(0.5)
    this.comboText.alpha = 0
    this.uiLayer.addChild(this.judgementText, this.comboText)
  }

  attachBeatClock(clock: BeatClock): void {
    this.beatClock = clock
  }

  setViewport(viewport: ViewportContext): void {
    this.viewport = viewport
    // Fill the WHOLE screen for immersion, not just the underwater band.
    this.centerX = viewport.width * 0.5
    this.centerY = viewport.height * 0.46
    this.judgementText.position.set(this.centerX, this.centerY - 30)
    this.comboText.position.set(this.centerX, this.centerY + 8)
  }

  start(fishDef: FishDef, stageIndex: number): void {
    this.stop()
    this.stageIndex = stageIndex
    this.combo = 0
    this.maxCombo = 0
    this.consecutiveMisses = 0
    this.activeHolds = { space: false, left: false, right: false }
    this.textTimer = 0
    this.judgementText.alpha = 0
    this.comboText.alpha = 0
    this.lastHit = null

    let hash = 0
    const key = `${fishDef.id}:${stageIndex}`
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0
    this.chartSeed = Math.abs(hash) + 1

    const beat = this.fractionalBeat(performance.now())
    this.nextSpawnBeat = Math.ceil(beat) + 3
  }

  stop(): void {
    for (const note of this.notes) this.disposeNote(note)
    this.notes = []
    for (const p of this.particles) {
      this.effectLayer.removeChild(p.graphic)
      p.graphic.destroy()
    }
    this.particles = []
  }

  setHoldState(key: InputKey, isPressed: boolean): void {
    this.activeHolds[key] = isPressed
  }

  isHoldActive(key: InputKey): boolean {
    return this.activeHolds[key]
  }

  registerTap(key: InputKey, nowMs: number): RhythmJudgement | null {
    if (!this.beatClock?.started) return null
    let best: RhythmNote | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const note of this.notes) {
      if (note.state !== 'live') continue
      if (!this.keyMatches(note, key)) continue
      const dist = Math.abs(nowMs - this.beatClock.perfTimeOfBeat(note.beatIndex))
      if (dist <= this.WINDOW_GOOD && dist < bestDist) {
        best = note
        bestDist = dist
      }
    }
    if (!best) return null

    const judgement: RhythmJudgement = bestDist <= this.WINDOW_PERFECT ? 'perfect' : 'good'
    best.state = 'hit'
    best.judgement = judgement
    this.combo += 1
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    this.consecutiveMisses = 0

    // Dynamically determine height based on the note's 3D Y position at tt = 0 (the head)
    const currentY = this.getArcY(best, 0)
    const height: NoteHeight = currentY < (this.GROUND_Y + this.AIR_Y) * 0.5 ? 'air' : 'ground'

    this.lastHit = { judgement, height, type: best.type }
    this.showJudgement(judgement)
    this.spawnHitParticles(best, judgement)
    return judgement
  }

  update(dtSeconds: number, nowMs: number): void {
    if (!this.beatClock?.started) return
    const beat = this.fractionalBeat(nowMs)

    while (this.nextSpawnBeat < beat + this.LOOK_AHEAD_BEATS) {
      this.spawnChartAtBeat(this.nextSpawnBeat)
      this.nextSpawnBeat += 0.5
    }

    this.drawTunnel(beat)
    this.drawGroundPlane(beat)
    this.drawAirRail(beat)
    this.drawHitCursor(beat)

    for (const note of this.notes) this.updateNoteVisual(note, beat, nowMs)

    this.notes = this.notes.filter((note) => {
      const expired = note.state !== 'live' && beat - note.beatIndex > note.durationBeats + 1.4
      if (!expired) return true
      this.disposeNote(note)
      return false
    })

    this.updateParticles(dtSeconds)
    this.updateTexts(dtSeconds)
  }

  project(x: number, y: number, z: number, beat: number): { x: number; y: number; scale: number } {
    const c = this.trackCenter(z, beat)
    const worldX = c.x + x
    const worldY = c.y + y
    const scale = this.FOCAL_LENGTH / (z + this.FOCAL_LENGTH)
    return { x: this.centerX + worldX * scale, y: this.centerY + worldY * scale, scale }
  }

  getArcX(note: RhythmNote, tt: number): number {
    const laneX = note.lane * this.LANE_SPREAD
    if (note.type !== 'arc' && note.type !== 'hold') return laneX

    const curve = note.curveType ?? 'straight'
    switch (curve) {
      case 'dive':
        // Starts at note.lane, sweeps to the opposite side, then sweeps back
        return laneX * Math.cos(tt * Math.PI)
      case 'wave':
        // Weaves left and right
        return laneX + Math.sin(tt * Math.PI * 2) * 120
      case 'helix':
        // Spiral-like sweep
        return laneX * Math.cos(tt * Math.PI * 1.5)
      case 'straight':
      default:
        return laneX
    }
  }

  getArcY(note: RhythmNote, tt: number): number {
    const baseY = this.noteWorldY(note) // AIR_Y for arc, GROUND_Y for hold
    if (note.type !== 'arc' && note.type !== 'hold') return baseY

    const curve = note.curveType ?? 'straight'
    switch (curve) {
      case 'dive':
        // Starts high (AIR_Y), dives deep down to GROUND_Y, then pulls back up
        const depth = this.GROUND_Y - this.AIR_Y // 460
        return this.AIR_Y + Math.sin(tt * Math.PI) * depth * 0.8
      case 'wave':
        // Waves up and down
        return baseY + Math.sin(tt * Math.PI * 3) * 60
      case 'helix':
        // Helix vertical wave
        return baseY + Math.sin(tt * Math.PI * 2) * 100
      case 'straight':
      default:
        // Standard arc has a slight upward arch
        return baseY - (note.type === 'arc' ? Math.sin(tt * Math.PI) * 70 : 0)
    }
  }

  /**
   * Returns the 3D position (x, y) of the currently active/held note.
   * If multiple are held, returns the one with the highest priority (e.g. arc/dual).
   * Coordinates are in world space (relative to track center, before projection).
   */
  getActiveHoldPosition(beat: number): { x: number; y: number; type: NoteType; curveType: string } | null {
    let bestNote: RhythmNote | null = null
    for (const note of this.notes) {
      if (note.state !== 'live' || note.durationBeats <= 0) continue
      if (beat < note.beatIndex || beat > note.beatIndex + note.durationBeats) continue

      // Check if the player is actually holding this note.
      const holding =
        note.type === 'hold'
          ? this.activeHolds.space
          : note.type === 'dual'
            ? this.activeHolds.left && this.activeHolds.right
            : this.activeHolds[note.lane < 0 ? 'left' : 'right']

      if (holding) {
        // Prefer dual/arc notes over standard ground holds for cooler animations.
        if (!bestNote || note.type === 'dual' || (note.type === 'arc' && bestNote.type === 'hold')) {
          bestNote = note
        }
      }
    }

    if (!bestNote) return null

    const tt = Math.max(0, Math.min(1, (beat - bestNote.beatIndex) / bestNote.durationBeats))
    return {
      x: this.getArcX(bestNote, tt),
      y: this.getArcY(bestNote, tt),
      type: bestNote.type,
      curveType: bestNote.curveType ?? 'straight',
    }
  }

  /** Spawns a trail of bubbles and sparkles at a specific screen coordinate (e.g. wingtip). */
  spawnWingtipTrail(x: number, y: number, color = 0x67e8f9): void {
    if (Math.random() > 0.4) {
      const g = new Graphics()
      if (Math.random() < 0.4) {
        // Sparkle
        g.poly([0, -4, 1.5, 0, 0, 4, -1.5, 0])
        g.fill({ color, alpha: 0.85 })
      } else {
        // Bubble
        g.circle(0, 0, 1.5 + Math.random() * 2)
        g.stroke({ color: 0xffffff, width: 1, alpha: 0.7 })
      }
      g.position.set(x, y)
      this.effectLayer.addChild(g)
      
      // Bubbles drift backwards (upwards and slightly outwards)
      const vx = (Math.random() - 0.5) * 20
      const vy = 40 + Math.random() * 40 // drift down/backwards
      const life = 0.3 + Math.random() * 0.2
      this.particles.push({
        graphic: g,
        vx,
        vy,
        life,
        totalLife: life,
        spin: Math.random() * Math.PI,
        spinV: (Math.random() - 0.5) * 4,
      })
    }
  }

  private noteWorldY(note: RhythmNote): number {
    return note.height === 'air' ? this.AIR_Y : this.GROUND_Y
  }

  private updateNoteVisual(note: RhythmNote, beat: number, nowMs: number): void {
    const beatDist = note.beatIndex - beat
    const z = this.Z_HIT + beatDist * 235

    if (note.state === 'live') {
      const miss = nowMs - this.beatClock!.perfTimeOfBeat(note.beatIndex) > this.WINDOW_GOOD
      if (miss) {
        note.state = 'missed'
        note.judgement = 'miss'
        this.combo = 0
        this.consecutiveMisses += 1
        this.showJudgement('miss')
      }
    }

    const head = note.head
    head.clear()
    if (z <= 0 || z >= this.Z_HORIZON + 140) {
      head.visible = false
      if (note.tail) note.tail.visible = false
      return
    }
    head.visible = true

    // Calculate tt for the note head. If the note is currently active, 
    // clamp z to Z_HIT and let the head slide along the parametric curve.
    const tt = note.durationBeats > 0 ? Math.max(0, Math.min(1, (beat - note.beatIndex) / note.durationBeats)) : 0
    let drawZ = z
    if (note.durationBeats > 0 && beat >= note.beatIndex && beat <= note.beatIndex + note.durationBeats) {
      drawZ = this.Z_HIT
    }

    const xVal = this.getArcX(note, tt)
    const yVal = this.getArcY(note, tt)
    const p = this.project(xVal, yVal, drawZ, beat)
    const baseAlpha = Math.min(1, (this.Z_HORIZON - drawZ) / 260)

    if (note.state === 'live') {
      if (note.height === 'ground') {
        this.drawGroundNote(head, note, p, baseAlpha)
      } else {
        this.drawAirNote(head, note, p, baseAlpha)
      }
    } else {
      const progress = Math.min(1, Math.max(0, (beat - note.beatIndex) * 3.2))
      if (progress >= 1) {
        head.visible = false
      } else {
        const r = (note.type === 'dual' ? 30 : 22) * p.scale
        head.circle(p.x, p.y, r * (1 + progress * 1.6))
        head.stroke({
          color: note.state === 'hit' ? 0xffffff : 0xf87171,
          width: 3,
          alpha: 1 - progress,
        })
      }
    }

    if (note.tail && note.durationBeats > 0) this.drawTail(note, beat)
    else if (note.tail) note.tail.visible = false
  }

  /** Ground note: a glowing floor TILE (rectangle aligned to the floor). */
  private drawGroundNote(g: Graphics, note: RhythmNote, p: { x: number; y: number; scale: number }, alpha: number): void {
    const w = (note.type === 'dual' ? 150 : 96) * p.scale
    const h = 26 * p.scale
    const color = note.type === 'dual' ? 0xf97316 : note.type === 'hold' ? 0x86efac : 0xfde68a
    g.roundRect(p.x - w / 2, p.y - h / 2, w, h, 6 * p.scale)
    g.fill({ color, alpha })
    g.stroke({ color: 0xffffff, width: Math.max(1, 2 * p.scale), alpha: alpha * 0.9 })
    // Bright leading edge so it reads as a tile sliding toward you.
    g.roundRect(p.x - w / 2, p.y + h / 2 - 5 * p.scale, w, 5 * p.scale, 3 * p.scale)
    g.fill({ color: 0xffffff, alpha: alpha * 0.5 })
  }

  /** Air note: a DIAMOND node (sky line), clearly different from floor tiles. */
  private drawAirNote(g: Graphics, note: RhythmNote, p: { x: number; y: number; scale: number }, alpha: number): void {
    const s = (note.type === 'dual' ? 26 : 19) * p.scale
    const color = note.type === 'arc' ? 0x67e8f9 : note.type === 'dual' ? 0xf97316 : 0xc4b5fd
    g.poly([p.x, p.y - s, p.x + s, p.y, p.x, p.y + s, p.x - s, p.y])
    g.fill({ color, alpha })
    g.stroke({ color: 0xffffff, width: Math.max(1, 2 * p.scale), alpha: alpha * 0.9 })
    g.circle(p.x, p.y, s * 0.35)
    g.fill({ color: 0xffffff, alpha: alpha * 0.85 })
  }

  /** Hold/arc ribbon with explicit head & tail connection knobs. */
  private drawTail(note: RhythmNote, beat: number): void {
    const tail = note.tail!
    tail.clear()
    tail.visible = true
    const points: Array<{ x: number; y: number; z: number }> = []
    const steps = 22
    for (let i = 0; i <= steps; i += 1) {
      const tt = i / steps
      const b = note.beatIndex + note.durationBeats * tt

      // If this part of the hold is already in the past, skip it so the ribbon cuts off at the hit line.
      if (b < beat && note.durationBeats > 0) {
        // To make a clean connection to the hit line, insert a point exactly at the current beat.
        if (i < steps) {
          const nextB = note.beatIndex + note.durationBeats * ((i + 1) / steps)
          if (nextB >= beat) {
            const ttCurrent = (beat - note.beatIndex) / note.durationBeats
            const xVal = this.getArcX(note, ttCurrent)
            const yVal = this.getArcY(note, ttCurrent)
            const p = this.project(xVal, yVal, this.Z_HIT, beat)
            points.push({ x: p.x, y: p.y, z: this.Z_HIT })
          }
        }
        continue
      }

      const bz = this.Z_HIT + (b - beat) * 235
      if (bz <= 8 || bz >= this.Z_HORIZON) continue

      const xVal = this.getArcX(note, tt)
      const yVal = this.getArcY(note, tt)
      const p = this.project(xVal, yVal, bz, beat)
      points.push({ x: p.x, y: p.y, z: bz })
    }
    if (points.length < 2) {
      tail.visible = false
      return
    }

    const holding =
      note.type === 'hold'
        ? this.activeHolds.space
        : note.type === 'dual'
          ? this.activeHolds.left && this.activeHolds.right
          : this.activeHolds[note.lane < 0 ? 'left' : 'right']
    const baseColor = note.type === 'arc' ? 0x67e8f9 : note.type === 'dual' ? 0xfb923c : 0x86efac
    const nearScale = this.FOCAL_LENGTH / (points[0].z + this.FOCAL_LENGTH)
    const width = Math.max(2, (note.type === 'arc' ? 7 : 10) * nearScale)

    tail.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i += 1) tail.lineTo(points[i].x, points[i].y)
    tail.stroke({
      color: holding ? 0xffffff : baseColor,
      width: holding ? width * 1.4 : width,
      alpha: holding ? 0.92 : 0.5,
      cap: 'round',
      join: 'round',
    })

    // HEAD & TAIL connection knobs (Arcaea-style).
    const head = points[0]
    const end = points[points.length - 1]
    const headScale = this.FOCAL_LENGTH / (head.z + this.FOCAL_LENGTH)
    const endScale = this.FOCAL_LENGTH / (end.z + this.FOCAL_LENGTH)
    tail.circle(head.x, head.y, 7 * headScale)
    tail.fill({ color: 0xffffff, alpha: 0.95 })
    tail.circle(head.x, head.y, 7 * headScale)
    tail.stroke({ color: baseColor, width: 2, alpha: 0.9 })
    tail.circle(end.x, end.y, 5 * endScale)
    tail.fill({ color: baseColor, alpha: 0.85 })
    tail.circle(end.x, end.y, 5 * endScale)
    tail.stroke({ color: 0xffffff, width: 1.5, alpha: 0.7 })
  }

  private keyMatches(note: RhythmNote, key: InputKey): boolean {
    if (note.type === 'tap' || note.type === 'hold') return key === 'space'
    if (note.type === 'dual') {
      if (key === 'space') return false
      return this.activeHolds.left && this.activeHolds.right
    }
    if (key === 'space') return false
    return note.lane < 0 ? key === 'left' : note.lane > 0 ? key === 'right' : key === 'left' || key === 'right'
  }

  private spawnChartAtBeat(beat: number): void {
    const bar = Math.floor(beat / 4)
    const step = Math.round((beat % 4) * 2) // 8 steps per bar
    const rand = this.seeded(this.chartSeed + bar * 17 + step * 11)
    const difficulty = Math.min(1, this.stageIndex / 14)

    // Spawn ground taps on step 0, 2, 4, 6
    if (step % 2 === 0) {
      if (rand < 0.25 + difficulty * 0.15) {
        this.push('tap', 0, 'ground', beat, rand)
      } else if (difficulty > 0.4 && rand > 0.8) {
        this.push('tap', rand > 0.9 ? -1 : 1, 'ground', beat, rand)
      }
    }

    // Spawn Arcs on step 0 and 4 (every 2 beats)
    if (step === 0 || step === 4) {
      if (rand < 0.6 + difficulty * 0.3) {
        const lane = rand < 0.5 ? -1 : 1
        const duration = 2.0 // 2 beats long arc
        
        // Choose a cool 3D space curve pattern
        const patternRand = this.seeded(this.chartSeed + beat * 3)
        if (patternRand < 0.25) {
          // Sky-to-Ground Dive (V-shape dive)
          // Starts at sky, dives to ground, ends at sky
          this.push('arc', lane, 'air', beat, rand, duration, 'dive', lane, 1, -lane, 1)
        } else if (patternRand < 0.5) {
          // Diagonal Climb
          // Starts at ground, climbs to sky on opposite side
          this.push('arc', lane, 'air', beat, rand, duration, 'straight', lane, 0, -lane, 1)
        } else if (patternRand < 0.75) {
          // Wave Weave
          // Starts at sky, waves down to ground on same side
          this.push('arc', lane, 'air', beat, rand, duration, 'wave', lane, 1, lane, 0)
        } else {
          // Helix Spiral
          // Starts at sky, spirals to opposite side ground
          this.push('arc', lane, 'air', beat, rand, duration, 'helix', lane, 1, -lane, 0)
        }
      }
    }

    // Spawn dual notes on high difficulty
    if (difficulty > 0.5 && step === 2 && rand < 0.2) {
      this.push('dual', 0, 'ground', beat, rand, 1.5, 'straight', -1, 1, 1, 1)
    }
  }

  private push(
    type: NoteType,
    lane: -1 | 0 | 1,
    height: NoteHeight,
    beat: number,
    rand: number,
    durationBeats = 0,
    curveType: 'straight' | 'dive' | 'wave' | 'helix' = 'straight',
    startX = 0,
    startY = 0,
    endX = 0,
    endY = 0,
  ): void {
    const head = new Graphics()
    this.noteLayer.addChild(head)
    let tail: Graphics | undefined
    if (durationBeats > 0) {
      tail = new Graphics()
      if (type === 'arc') this.arcLayer.addChild(tail)
      else this.noteLayer.addChild(tail)
    }

    // Default normalized coordinates if not provided
    const finalStartX = startX !== 0 || startY !== 0 || endX !== 0 || endY !== 0 ? startX : lane
    const finalStartY = startX !== 0 || startY !== 0 || endX !== 0 || endY !== 0 ? startY : height === 'air' ? 1 : 0
    const finalEndX = startX !== 0 || startY !== 0 || endX !== 0 || endY !== 0 ? endX : lane
    const finalEndY = startX !== 0 || startY !== 0 || endX !== 0 || endY !== 0 ? endY : height === 'air' ? 1 : 0

    this.notes.push({
      id: `n_${beat}_${type}_${lane}_${rand.toFixed(4)}`,
      beatIndex: beat,
      durationBeats,
      type,
      lane,
      height,
      state: 'live',
      judgement: null,
      head,
      tail,
      curveType,
      startX: finalStartX,
      startY: finalStartY,
      endX: finalEndX,
      endY: finalEndY,
    })
  }

  private disposeNote(note: RhythmNote): void {
    this.noteLayer.removeChild(note.head)
    note.head.destroy()
    if (note.tail) {
      if (note.type === 'arc') this.arcLayer.removeChild(note.tail)
      else this.noteLayer.removeChild(note.tail)
      note.tail.destroy()
    }
  }

  private drawTunnel(beat: number): void {
    const g = this.tunnelLayer
    g.removeChildren()
    const rings = 12
    for (let i = 0; i < rings; i += 1) {
      const z = (i / rings) * this.Z_HORIZON + ((beat * 160) % (this.Z_HORIZON / rings))
      const p = this.project(0, 0, z, beat)
      const ring = new Graphics()
      ring.circle(p.x, p.y, 320 * p.scale)
      ring.stroke({
        color: 0x1d4ed8,
        width: Math.max(1, 3 * p.scale),
        alpha: 0.06 + (1 - z / this.Z_HORIZON) * 0.1,
      })
      g.addChild(ring)
    }
  }

  /** Receding FLOOR plane (trapezoid) with lane dividers. */
  private drawGroundPlane(beat: number): void {
    const g = this.groundPlane
    g.clear()
    this.horizonGlow.clear()
    const horizon = this.project(0, this.GROUND_Y * 0.2, this.Z_HORIZON * 0.95, beat)
    this.horizonGlow.circle(horizon.x, horizon.y, 60)
    this.horizonGlow.fill({ color: 0x22d3ee, alpha: 0.18 })

    const nearL = this.project(-this.LANE_SPREAD * 1.6, this.GROUND_Y, this.Z_HIT, beat)
    const nearR = this.project(this.LANE_SPREAD * 1.6, this.GROUND_Y, this.Z_HIT, beat)
    const farL = this.project(-this.LANE_SPREAD * 1.1, this.GROUND_Y, this.Z_HORIZON, beat)
    const farR = this.project(this.LANE_SPREAD * 1.1, this.GROUND_Y, this.Z_HORIZON, beat)
    g.poly([nearL.x, nearL.y, nearR.x, nearR.y, farR.x, farR.y, farL.x, farL.y])
    g.fill({ color: 0x0b2a6b, alpha: 0.42 })

    for (const lane of [-1, 0, 1] as const) {
      const near = this.project(lane * this.LANE_SPREAD, this.GROUND_Y, this.Z_HIT, beat)
      const far = this.project(lane * this.LANE_SPREAD, this.GROUND_Y, this.Z_HORIZON, beat)
      g.moveTo(near.x, near.y)
      g.lineTo(far.x, far.y)
      g.stroke({
        color: lane === 0 ? 0xfde68a : 0x60a5fa,
        width: lane === 0 ? 3 : 2,
        alpha: lane === 0 ? 0.5 : 0.34,
      })
    }
    // Beat rungs sliding along the floor for a sense of speed.
    for (let i = 0; i < 8; i += 1) {
      const z = this.Z_HIT + (((beat * 235 + i * (this.Z_HORIZON / 8)) % this.Z_HORIZON))
      const l = this.project(-this.LANE_SPREAD * 1.3, this.GROUND_Y, z, beat)
      const r = this.project(this.LANE_SPREAD * 1.3, this.GROUND_Y, z, beat)
      g.moveTo(l.x, l.y)
      g.lineTo(r.x, r.y)
      g.stroke({ color: 0x3b82f6, width: Math.max(1, 2 * l.scale), alpha: 0.2 })
    }
  }

  /** Elevated SKY rails — visually distinct dashed cyan lines up high. */
  private drawAirRail(beat: number): void {
    const g = this.airRail
    g.clear()
    for (const lane of [-1, 1] as const) {
      const near = this.project(lane * this.LANE_SPREAD, this.AIR_Y, this.Z_HIT, beat)
      const far = this.project(lane * this.LANE_SPREAD, this.AIR_Y, this.Z_HORIZON, beat)
      g.moveTo(near.x, near.y)
      g.lineTo(far.x, far.y)
      g.stroke({ color: 0x67e8f9, width: 2, alpha: 0.3 })
      // Vertical tethers connecting sky rail to the floor (depth cue).
      const groundNear = this.project(lane * this.LANE_SPREAD, this.GROUND_Y, this.Z_HIT, beat)
      g.moveTo(near.x, near.y)
      g.lineTo(groundNear.x, groundNear.y)
      g.stroke({ color: 0x67e8f9, width: 1, alpha: 0.12 })
    }
  }

  private drawHitCursor(beat: number): void {
    const g = this.hitCursor
    g.clear()
    const pulse = 1 + (beat % 1 < 0.2 ? (0.2 - (beat % 1)) * 2 : 0)

    // 1. Center-bottom (Ground Judge Ring)
    const gp = this.project(0, this.GROUND_Y, this.Z_HIT, beat)
    g.circle(gp.x, gp.y, 34 * pulse)
    g.stroke({ color: 0xfde68a, width: 2.5, alpha: 0.8 })
    g.moveTo(gp.x - 60, gp.y)
    g.lineTo(gp.x - 24, gp.y)
    g.moveTo(gp.x + 24, gp.y)
    g.lineTo(gp.x + 60, gp.y)
    g.stroke({ color: 0xe2e8f0, width: 1.4, alpha: 0.5 })

    // 2. Left-top (Left Air Judge Ring)
    const lp = this.project(-this.LANE_SPREAD, this.AIR_Y, this.Z_HIT, beat)
    g.circle(lp.x, lp.y, 26 * pulse)
    g.stroke({ color: 0x67e8f9, width: 2, alpha: 0.7 })
    g.moveTo(lp.x - 40, lp.y)
    g.lineTo(lp.x - 18, lp.y)
    g.moveTo(lp.x + 18, lp.y)
    g.lineTo(lp.x + 40, lp.y)
    g.stroke({ color: 0x67e8f9, width: 1.2, alpha: 0.4 })

    // 3. Right-top (Right Air Judge Ring)
    const rp = this.project(this.LANE_SPREAD, this.AIR_Y, this.Z_HIT, beat)
    g.circle(rp.x, rp.y, 26 * pulse)
    g.stroke({ color: 0x67e8f9, width: 2, alpha: 0.7 })
    g.moveTo(rp.x - 40, rp.y)
    g.lineTo(rp.x - 18, rp.y)
    g.moveTo(rp.x + 18, rp.y)
    g.lineTo(rp.x + 40, rp.y)
    g.stroke({ color: 0x67e8f9, width: 1.2, alpha: 0.4 })
  }

  private showJudgement(judgement: RhythmJudgement): void {
    this.judgementText.text = judgement.toUpperCase()
    this.judgementText.style.fill =
      judgement === 'perfect' ? '#ffd166' : judgement === 'good' ? '#7dd3fc' : '#f87171'
    this.judgementText.alpha = 1
    this.textTimer = 0.7
    if (this.combo >= 3) {
      this.comboText.text = `${this.combo} COMBO`
      this.comboText.alpha = 1
    } else {
      this.comboText.alpha = 0
    }
  }

  /** Ground hit = upward dust burst; air hit = radial ring sparkle. */
  private spawnHitParticles(note: RhythmNote, judgement: RhythmJudgement): void {
    const beat = this.fractionalBeat()
    const tt = note.durationBeats > 0 ? Math.max(0, Math.min(1, (beat - note.beatIndex) / note.durationBeats)) : 0
    const currentY = this.getArcY(note, tt)
    const currentX = this.getArcX(note, tt)
    const anchor = this.project(currentX, currentY, this.Z_HIT, beat)
    
    const isAir = currentY < (this.GROUND_Y + this.AIR_Y) * 0.5

    if (!isAir) {
      const color = judgement === 'perfect' ? 0xfde68a : 0xfacc15
      const count = judgement === 'perfect' ? 16 : 9
      for (let i = 0; i < count; i += 1) {
        const g = new Graphics()
        g.rect(-2, -2, 4, 4)
        g.fill({ color, alpha: 0.95 })
        g.position.set(anchor.x + (Math.random() - 0.5) * 30, anchor.y)
        this.effectLayer.addChild(g)
        // Dust kicks UP and outward.
        const vx = (Math.random() - 0.5) * 160
        const vy = -120 - Math.random() * 160
        const life = 0.45 + Math.random() * 0.25
        this.particles.push({ graphic: g, vx, vy, life, totalLife: life, spin: 0, spinV: (Math.random() - 0.5) * 12 })
      }
    } else {
      const color = judgement === 'perfect' ? 0x67e8f9 : 0x38bdf8
      const count = judgement === 'perfect' ? 14 : 8
      for (let i = 0; i < count; i += 1) {
        const g = new Graphics()
        g.poly([0, -5, 2, 0, 0, 5, -2, 0])
        g.fill({ color, alpha: 0.95 })
        g.position.set(anchor.x, anchor.y)
        this.effectLayer.addChild(g)
        // Radial sparkle ring.
        const a = (i / count) * Math.PI * 2
        const speed = 150 + Math.random() * 120
        const life = 0.4 + Math.random() * 0.2
        this.particles.push({
          graphic: g,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life,
          totalLife: life,
          spin: a,
          spinV: 6,
        })
      }
    }
  }

  private updateParticles(dtSeconds: number): void {
    for (const p of this.particles) {
      p.life -= dtSeconds
      const t = Math.max(0, p.life / p.totalLife)
      p.graphic.position.x += p.vx * dtSeconds
      p.graphic.position.y += p.vy * dtSeconds
      p.vy += 320 * dtSeconds // gravity (dust falls back, sparkles drift)
      p.spin += p.spinV * dtSeconds
      p.graphic.rotation = p.spin
      p.graphic.alpha = t
      p.graphic.scale.set(0.4 + (1 - t) * 0.9)
    }
    this.particles = this.particles.filter((p) => {
      if (p.life > 0) return true
      this.effectLayer.removeChild(p.graphic)
      p.graphic.destroy()
      return false
    })
  }

  private updateTexts(dtSeconds: number): void {
    if (this.textTimer <= 0) return
    this.textTimer -= dtSeconds
    if (this.textTimer <= 0) {
      this.judgementText.alpha = 0
      this.comboText.alpha = 0
      return
    }
    if (this.textTimer < 0.25) {
      const a = this.textTimer / 0.25
      this.judgementText.alpha = a
      this.comboText.alpha = Math.min(this.comboText.alpha, a)
    }
  }

  private trackCenter(z: number, beat: number): { x: number; y: number } {
    const seed = (this.chartSeed % 17) * 0.21
    const swing = 70 + Math.min(6, this.stageIndex) * 10
    const lift = 24 + Math.min(6, this.stageIndex) * 5
    return {
      x: Math.sin(beat * 0.2 + z * 0.0016 + seed) * swing,
      y: Math.cos(beat * 0.16 + z * 0.0013 + seed * 1.7) * lift,
    }
  }

  fractionalBeat(now = performance.now()): number {
    if (!this.beatClock?.started) return 0
    return this.beatClock.currentBeat(now) + this.beatClock.phase(now)
  }

  private seeded(n: number): number {
    const v = Math.sin(n * 12.9898 + this.chartSeed * 78.233) * 43758.5453
    return v - Math.floor(v)
  }
}
