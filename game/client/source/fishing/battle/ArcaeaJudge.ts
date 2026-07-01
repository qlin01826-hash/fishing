import type { BeatClock } from '../systems/BeatClock'
import type { TrackSplineProvider } from '../chase/TrackSplineProvider'
import type { Transform3D } from '../chase/Transform3D'
import { LANE_X } from '../chase/DualLayerChart'

// --------------- Judgement enum & timing windows ---------------

export type Judgement = 'PURE' | 'FAR' | 'LOST'

/** Seconds either side of the perfect beat centre (floor notes). */
const PURE_WINDOW_SEC = 0.04
const FAR_WINDOW_SEC = 0.12

/**
 * Sky-arc tracking tolerance, in LOGICAL (CSS) pixels — the same space
 * Transform3D projects into and pointer input is normalised to, so it is
 * device-independent (NO devicePixelRatio scaling; multiplying by DPR would
 * re-break Retina alignment that the CSS-space pipeline already solved).
 *
 * Dual-layer "hitbox expansion" (the commercial-rhythm-game trick): the grab
 * radius is strict before you're on the slide (anti-misgrab) and balloons once
 * you're riding it, so micro finger-jitter on slick glass can't false-drop the
 * chain — "if you got on, you stay on".
 */
const ARC_BASE_RADIUS_PX = 55
const ARC_EXPANDED_RADIUS_PX = 95
/** Interval between sky-arc combo ticks (ms). */
const ARC_TICK_INTERVAL_MS = 100
/**
 * Forward look-ahead band (in beats) the finger may grab the slide along. The
 * judgement is NOT a single swept Z=0 pixel — it samples the *continuous* curve
 * from the judge plane up its visible near segment, so a finger resting anywhere
 * on the drawn ribbon tracks instead of only when the Z=0 point sweeps under it.
 */
const ARC_BAND_BEATS = 3
/** Parametric sampling step across the band (smaller = smoother, costlier). */
const ARC_BAND_STEP = 0.4
/**
 * Combo-break debounce: how many consecutive off-target frames are tolerated
 * before a dropped ride zeroes the combo. This ONLY delays the LOST penalty —
 * it does not keep the arc lit or auto-ticking, and it never gates re-entry.
 * Slide a finger back within this window and the chain continues seamlessly.
 */
const ARC_MISS_BUFFER_FRAMES = 4

/**
 * Curvature-adaptive hitbox expansion (the "commercial rhythm-game secret").
 * When the slide whips laterally faster than |Δchart-x| = {@link ARC_SHARP_VX}
 * per second — the ~human-impossible left↔right returns — we secretly balloon
 * the grab radius to {@link ARC_CORNER_RADIUS_PX}, widen the depth sweep window
 * ×1.5, and let a secured ride LINGER {@link CORNER_LINGER_FRAMES} extra frames
 * at the apex. The finger only has to graze the corner and the chain holds.
 */
const ARC_SHARP_VX = 1.3
const ARC_CORNER_RADIUS_PX = 120
const ARC_BAND_CORNER_MUL = 1.5
const CORNER_LINGER_FRAMES = 3

/**
 * Squared shortest distance from point (px,py) to segment (x1,y1)-(x2,y2).
 * Squared to skip the sqrt in the hot multi-touch × multi-slice loop.
 */
function pointSegDistSq(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const ex = px - (x1 + t * dx)
  const ey = py - (y1 + t * dy)
  return ex * ex + ey * ey
}

// --------------- Floor note ---------------

export interface FloorNote {
  id: number
  beatIndex: number
  lane: number
  /** Exact performance.now() ms when this note crosses Z=0. */
  targetMs: number
  state: 'active' | 'judged' | 'lost'
  judgement: Judgement | null
  /** Visual effect countdown (seconds). */
  effectT: number
}

// --------------- Multi-touch pointer table ---------------

export interface PointerSample {
  x: number
  y: number
}

// --------------- Chase adapter (projection + penguin control) ---------------

/**
 * Bridges the pure judgement math to the 3D chase renderer:
 *  - {@link projectToScreen}: world (X,Y,Z) → screen pixels using the SAME
 *    camera dynamics the renderer used this frame (so the arc's judgement
 *    pixel coincides with what the player sees).
 *  - {@link snapPenguinToLx}: force the diver onto the arc's lateral position
 *    while the finger is locked (the "ride the stream" feedback).
 *  - {@link emitTrackBurst}: spawn cavitation-bubble FX on a successful tick.
 *  - {@link setTrackPointer}: report the riding finger's pixel position (or
 *    null when released) so the renderer can draw the tether/electric line.
 */
export interface ChaseAdapter {
  projectToScreen(worldX: number, worldY: number, worldZ: number): PointerSample | null
  snapPenguinToLx(lx: number): void
  emitTrackBurst(): void
  setTrackPointer(x: number | null, y: number | null): void
}

// --------------- Event emitter ---------------

export interface JudgeEvent {
  type: 'floor' | 'sky-tick'
  judgement: Judgement
  /** Screen-space X for the floating text (-1 = use HUD fallback centre). */
  screenX: number
  /** Screen-space Y for the floating text (-1 = use HUD fallback centre). */
  screenY: number
  /** Struck floor lane (0..3) — drives the lane-flash + impact burst FX. */
  lane?: number
}

// --------------- Main class ---------------

/**
 * Arcaea-style dual-layer judgement engine for the "penguin chases fish" battle.
 *
 * **Floor notes** (4-lane discrete taps): the player presses the correct lane
 * key/touch zone; we compare |now - targetTime| against PURE/FAR/LOST windows.
 *
 * **Sky arcs** (continuous slide): EVERY FRAME, for each arc currently crossing
 * the Z=0 judgement plane, we sample its 3D position at the plane, project it to
 * screen pixels, and test the pixel distance to every active finger. If any
 * finger is within {@link ARC_HIT_RADIUS_PX}, the arc is "secured": the diver
 * snaps onto it and a PURE combo tick fires every {@link ARC_TICK_INTERVAL_MS}.
 * Losing the finger mid-arc resets the combo immediately.
 */
export class ArcaeaJudge {
  // ---- public read state ----
  combo = 0
  maxCombo = 0
  pureCount = 0
  farCount = 0
  lostCount = 0
  /** Callback fired on every judgement — drives the HUD. */
  onJudge: (ev: JudgeEvent) => void = () => {}

  readonly floorNotes: FloorNote[] = []

  // ---- stateless sky-stream tracking ----
  /**
   * THIS frame's tracked state — equals `isSecuredThisFrame` exactly. There is
   * NO activation lock: any frame a finger is on the Z=0 slice it reads true,
   * any frame it isn't it reads false. Re-entry mid-stream is always allowed.
   */
  private skyTracked = false
  /**
   * Memory used ONLY to decide whether a *drop* should break the combo (so a
   * player doing floor notes without ever touching the sky isn't punished).
   * It never blocks securing/re-entry.
   */
  private skyChainActive = false
  /** Consecutive off-target frames — debounces the combo-break, not securing. */
  private skyMissFrames = 0
  /** Next performance.now() ms a combo tick fires while secured. */
  private skyNextTickMs = 0
  /** Previous frame's Z=0 anchor pixel — temporal sweep segment endpoint. */
  private lastSkyScreenX = 0
  private lastSkyScreenY = 0
  private hasLastSkyScreen = false
  /** Previous frame's chart-x at Z=0 — for curvature (velocityX) detection. */
  private lastSkyX = 0
  private hasLastSkyX = false
  /** Remaining forced-hold frames through a sharp-corner apex. */
  private cornerLinger = 0
  /** Exposed to the renderer: paint the bright glow material while true. */
  get skyGlowing(): boolean {
    return this.skyTracked
  }

  // ---- internal ----
  private readonly clock: BeatClock
  private readonly track: TrackSplineProvider
  private adapter: ChaseAdapter | null = null
  private nextId = 0
  private nextSpawnBeat = 0
  private readonly spawnAhead = 14
  private started = false

  constructor(clock: BeatClock, track: TrackSplineProvider) {
    this.clock = clock
    this.track = track
  }

  setChaseAdapter(adapter: ChaseAdapter): void {
    this.adapter = adapter
  }

  start(): void {
    this.floorNotes.length = 0
    this.combo = 0
    this.maxCombo = 0
    this.pureCount = 0
    this.farCount = 0
    this.lostCount = 0
    this.nextId = 0
    this.skyTracked = false
    this.skyChainActive = false
    this.skyMissFrames = 0
    this.skyNextTickMs = 0
    this.hasLastSkyScreen = false
    this.hasLastSkyX = false
    this.cornerLinger = 0
    this.started = true
    if (this.clock.started) {
      this.nextSpawnBeat = Math.ceil(this.clock.currentBeat()) + 1
    }
  }

  stop(): void {
    this.started = false
  }

  // ---- per-frame update ----

  /**
   * Must be called every frame.
   *
   * @param dtSec    Frame delta (seconds).
   * @param pointers All currently-pressed pointers (multi-touch), keyed by id.
   */
  update(dtSec: number, pointers: ReadonlyMap<number, PointerSample>): void {
    if (!this.started || !this.clock.started) return
    const nowMs = performance.now()
    const scroll = this.clock.currentBeat(nowMs) + this.clock.phase(nowMs)

    // ---- spawn upcoming notes ----
    const horizon = scroll + this.spawnAhead
    while (this.nextSpawnBeat < horizon) {
      this.spawnBeat(this.nextSpawnBeat)
      this.nextSpawnBeat++
    }

    // ---- auto-miss stale floor notes ----
    for (const note of this.floorNotes) {
      if (note.state !== 'active') continue
      const dt = (nowMs - note.targetMs) / 1000
      if (dt > FAR_WINDOW_SEC) {
        note.state = 'lost'
        note.judgement = 'LOST'
        note.effectT = 0.5
        this.registerLost()
        this.onJudge({ type: 'floor', judgement: 'LOST', screenX: -1, screenY: -1 })
      }
    }

    // ---- continuous sky-stream per-frame pixel tracking ----
    this.updateSkyStream(dtSec, nowMs, scroll, pointers)

    // ---- decay visual effect timers ----
    for (const note of this.floorNotes) {
      if (note.state !== 'active') note.effectT -= dtSec * 3
    }

    // ---- garbage collect spent notes ----
    for (let i = this.floorNotes.length - 1; i >= 0; i--) {
      const n = this.floorNotes[i]
      if (n.state !== 'active' && n.effectT <= 0) this.floorNotes.splice(i, 1)
    }
  }

  /**
   * STATELESS per-frame sky-stream judgement. There is no activation gate, no
   * "started" lock, no head/tail event — every frame is evaluated from scratch:
   *
   *  1. Parametric sample: `skyAtBeat(scroll)` evaluates the spline at the exact
   *     fractional beat (= absolute time progress) — a unique (X,Y) every ms,
   *     never "nearest node".
   *  2. Project that single point to the Z=0 judgement pixel the player sees.
   *  3. One distance test vs every active finger → `isSecuredThisFrame`.
   *  4. `skyTracked = isSecuredThisFrame` — the glow/snap follow the finger
   *     EXACTLY this frame. Put a finger on the slice at ANY time/position and
   *     it instantly lights + ticks; lift it and it instantly dims.
   *  5. The ONLY memory is a 4-frame debounce on the combo-break so micro
   *     jitter / sub-100ms gaps don't nuke the chain. It never blocks re-entry.
   */
  private updateSkyStream(
    dtSec: number,
    nowMs: number,
    scroll: number,
    pointers: ReadonlyMap<number, PointerSample>,
  ): void {
    const tf = this.track.transform3DRef
    const halfWidth = tf.trackHalfWidth

    // 0) Rhythmic breathing: during a sky REST beat there is no slide to ride —
    //    end the phrase cleanly (no LOST penalty, the silence is intentional) so
    //    the player can drop to the floor burst, then re-grab the next arc.
    if (this.track.getSkyNodeAtBeat(Math.floor(scroll)).type === 'rest') {
      this.skyTracked = false
      this.skyChainActive = false
      this.skyMissFrames = 0
      this.hasLastSkyScreen = false
      this.hasLastSkyX = false
      this.cornerLinger = 0
      this.adapter?.setTrackPointer(null, null)
      return
    }

    // 1) Z=0 anchor (the judge plane). The penguin rides this lateral position
    //    and the combo text spawns here. Pure parametric LERP of the spline at
    //    the exact fractional beat — never a "nearest node".
    const sky = this.track.skyAtBeat(scroll)
    const screen = this.adapter?.projectToScreen(sky.x * halfWidth, tf.skyChartYToWorldY(sky.y), 0) ?? null
    if (!screen) {
      this.skyTracked = false
      this.skyChainActive = false
      this.skyMissFrames = 0
      this.hasLastSkyScreen = false
      this.hasLastSkyX = false
      this.cornerLinger = 0
      this.adapter?.setTrackPointer(null, null)
      return
    }

    // Curvature (velocityX) detection: how fast the slide is sweeping across the
    // lane at the judge plane this frame. A whip-fast return trips "sharp corner".
    let sharpCorner = false
    if (this.hasLastSkyX && dtSec > 0) {
      const velocityX = Math.abs(sky.x - this.lastSkyX) / dtSec
      sharpCorner = velocityX > ARC_SHARP_VX
    }
    this.lastSkyX = sky.x
    this.hasLastSkyX = true

    // Hitbox expansion: if we were riding LAST frame, use the generous radius so
    // a tiny wobble can't drop us; otherwise the strict grab radius. A SHARP
    // CORNER secretly balloons it further (to 120px) and widens the depth sweep.
    const ridingRadius = this.skyTracked ? ARC_EXPANDED_RADIUS_PX : ARC_BASE_RADIUS_PX
    const radius = sharpCorner ? ARC_CORNER_RADIUS_PX : ridingRadius
    const radiusSq = radius * radius
    const bandBeats = sharpCorner ? ARC_BAND_BEATS * ARC_BAND_CORNER_MUL : ARC_BAND_BEATS

    // 2) Continuous SWEEP test. Instead of testing isolated sample points (which
    //    leave near-field gaps between samples and let a fast finger/anchor slip
    //    between frames), we build the visible slide as a projected polyline and
    //    test each finger's shortest distance to the SEGMENTS:
    //      (a) temporal: last frame's anchor → this frame's anchor (kills the
    //          inter-frame teleport of the swept Z=0 point), and
    //      (b) spatial: the continuous curve walked forward across the band.
    //    A finger within `radius` of ANY segment secures the ride — stateless,
    //    so instant disconnect / re-entry anywhere mid-slide still holds.
    let securedNow = false
    let hitX = 0
    let hitY = 0

    // (a) Temporal sweep segment.
    if (this.hasLastSkyScreen) {
      for (const p of pointers.values()) {
        if (
          pointSegDistSq(p.x, p.y, this.lastSkyScreenX, this.lastSkyScreenY, screen.x, screen.y) <=
          radiusSq
        ) {
          securedNow = true
          hitX = p.x
          hitY = p.y
          break
        }
      }
    }

    // (b) Spatial sweep along the continuous curve.
    let prevX = screen.x
    let prevY = screen.y
    let prevValid = true
    for (let ba = ARC_BAND_STEP; ba <= bandBeats && !securedNow; ba += ARC_BAND_STEP) {
      const slice = this.sampleSliceScreen(scroll + ba, ba, halfWidth, tf)
      if (!slice) {
        prevValid = false
        continue
      }
      const sx = prevValid ? prevX : slice.x
      const sy = prevValid ? prevY : slice.y
      for (const p of pointers.values()) {
        if (pointSegDistSq(p.x, p.y, sx, sy, slice.x, slice.y) <= radiusSq) {
          securedNow = true
          hitX = p.x
          hitY = p.y
          break
        }
      }
      prevX = slice.x
      prevY = slice.y
      prevValid = true
    }

    // Cache this frame's anchor for next frame's temporal sweep.
    this.lastSkyScreenX = screen.x
    this.lastSkyScreenY = screen.y
    this.hasLastSkyScreen = true

    // Curvature frame-linger: a genuine grab at a whip-fast corner re-arms the
    // linger; if the finger then blips off for 1-3 frames right at the apex, we
    // FORCE the ride to hold (only while a chain is active) so the corner can't
    // false-drop the combo — the "tenderly pass" the player expects.
    if (securedNow && sharpCorner) {
      this.cornerLinger = CORNER_LINGER_FRAMES
    } else if (!securedNow && sharpCorner && this.skyChainActive && this.cornerLinger > 0) {
      this.cornerLinger--
      securedNow = true
      hitX = screen.x
      hitY = screen.y
    }

    // 4) THIS frame's state is decided purely by securedNow — no lock, instant
    //    late re-entry, instant disconnect.
    this.skyTracked = securedNow

    if (securedNow) {
      // Light up + ride + tick the instant a finger is on the slice.
      this.skyChainActive = true
      this.skyMissFrames = 0
      this.adapter?.snapPenguinToLx(sky.x)
      this.adapter?.setTrackPointer(hitX, hitY)
      if (nowMs >= this.skyNextTickMs) {
        this.registerPure()
        this.adapter?.emitTrackBurst()
        this.onJudge({ type: 'sky-tick', judgement: 'PURE', screenX: screen.x, screenY: screen.y })
        this.skyNextTickMs = nowMs + ARC_TICK_INTERVAL_MS
      }
    } else {
      // Disconnected this frame: dim immediately, re-arm so re-entry ticks at once.
      this.skyNextTickMs = nowMs
      this.adapter?.setTrackPointer(null, null)
      // Combo-break debounce: only punish a *dropped* chain after >4 missed
      // frames (never a finger that simply never grabbed the stream).
      if (this.skyChainActive) {
        this.skyMissFrames++
        if (this.skyMissFrames > ARC_MISS_BUFFER_FRAMES) {
          this.skyChainActive = false
          if (this.combo > 0) {
            this.combo = 0
            this.onJudge({ type: 'sky-tick', judgement: 'LOST', screenX: screen.x, screenY: screen.y })
          }
        }
      }
    }
  }

  /**
   * Project one continuous slide micro-slice (curve eval at `beat`, depth from
   * `beatAhead`) to the screen pixel the player sees this frame. Used by the
   * forward-band finger scan in {@link updateSkyStream}.
   */
  private sampleSliceScreen(
    beat: number,
    beatAhead: number,
    halfWidth: number,
    tf: Transform3D,
  ): PointerSample | null {
    const s = this.track.skyAtBeat(beat)
    return (
      this.adapter?.projectToScreen(
        s.x * halfWidth,
        tf.skyChartYToWorldY(s.y),
        tf.beatAheadToZ(beatAhead),
      ) ?? null
    )
  }

  // ---- player input: floor tap ----

  hitLane(lane: number, nowMs = performance.now()): Judgement | null {
    if (!this.started || !this.clock.started) return null
    let best: FloorNote | null = null
    let bestDist = Infinity
    for (const note of this.floorNotes) {
      if (note.state !== 'active') continue
      if (note.lane !== lane) continue
      const dist = Math.abs(nowMs - note.targetMs)
      if (dist < bestDist) {
        bestDist = dist
        best = note
      }
    }
    if (!best) return null
    const dtSec = bestDist / 1000
    if (dtSec > FAR_WINDOW_SEC) return null
    const judgement: Judgement = dtSec <= PURE_WINDOW_SEC ? 'PURE' : 'FAR'
    best.state = 'judged'
    best.judgement = judgement
    best.effectT = 0.5
    if (judgement === 'PURE') this.registerPure()
    else this.registerFar()
    // Project the struck lane at the judge plane so the HUD float + impact FX
    // fire exactly where the pearl was tapped.
    const half = this.track.transform3DRef.trackHalfWidth
    const scr = this.adapter?.projectToScreen((LANE_X[best.lane] ?? 0) * half, 0, 0) ?? null
    this.onJudge({
      type: 'floor',
      judgement,
      screenX: scr ? scr.x : -1,
      screenY: scr ? scr.y : -1,
      lane: best.lane,
    })
    return judgement
  }

  // ---- private helpers ----

  private spawnBeat(beat: number): void {
    const groundNode = this.track.getGroundNodeAtBeat(beat)
    if (groundNode.type === 'tap' || groundNode.type === 'hold') {
      this.floorNotes.push({
        id: this.nextId++,
        beatIndex: beat,
        lane: groundNode.lane,
        targetMs: this.clock.perfTimeOfBeat(beat),
        state: 'active',
        judgement: null,
        effectT: 0,
      })
    }

    // The sky ribbon is a single continuous stream judged every frame in
    // updateSkyStream() — no discrete sky-arc objects are spawned here.
  }

  private registerPure(): void {
    this.pureCount++
    this.combo++
    if (this.combo > this.maxCombo) this.maxCombo = this.combo
  }

  private registerFar(): void {
    this.farCount++
    this.combo++
    if (this.combo > this.maxCombo) this.maxCombo = this.combo
  }

  private registerLost(): void {
    this.lostCount++
    this.combo = 0
  }
}
