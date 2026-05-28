/**
 * Musical clock that drives the rhythm-game layer.
 *
 * Two time domains coexist in this codebase:
 *   - `performance.now()` for input + visuals (matches pointer event
 *     timestamps so we can score tap accuracy exactly).
 *   - `AudioContext.currentTime` for sample-accurate audio scheduling.
 *
 * They drift slightly over very long sessions, but for one fishing
 * battle (< 1 minute) they stay aligned within a few ms once anchored
 * by `start()`.
 *
 * The clock is dormant until `start()` is called from inside a user
 * gesture (Web Audio autoplay policy). Until then any timing query
 * returns "no beat" sentinel values so the visual layer just shows a
 * static ring with no expectation of input.
 */
export class BeatClock {
  bpm = 92
  /** Optional sync to weather: storm boosts BPM slightly. */
  private targetBpm = 92

  private _beatIntervalMs = 60_000 / 92
  private perfStart = 0
  private audioStart = 0

  /** True once `start()` has run (audio context unlocked). */
  started = false

  start(audioCurrentTimeSeconds: number, now = performance.now()): void {
    if (this.started) return
    this.perfStart = now
    this.audioStart = audioCurrentTimeSeconds
    this.started = true
  }

  /**
   * Re-anchor the clock with a new BPM without breaking the current
   * beat's phase. Used when weather intensity shifts.
   */
  setBpm(bpm: number): void {
    this.targetBpm = bpm
    if (!this.started) {
      this.bpm = bpm
      this._beatIntervalMs = 60_000 / bpm
      return
    }
    // Rebase so the NEXT beat lands exactly when it would have without
    // a BPM change. Keeps drums and visuals continuous.
    const now = performance.now()
    const elapsedSec = (now - this.perfStart) / 1000
    this.audioStart = this.audioStart + elapsedSec
    this.perfStart = now
    this.bpm = bpm
    this._beatIntervalMs = 60_000 / bpm
  }

  get beatIntervalMs(): number {
    return this._beatIntervalMs
  }

  get beatIntervalSec(): number {
    return 60 / this.bpm
  }

  get targetBeatsPerMinute(): number {
    return this.targetBpm
  }

  /** Phase 0..1 within the current beat (0 = on beat). */
  phase(now = performance.now()): number {
    if (!this.started) return 0
    const elapsed = now - this.perfStart
    const m = ((elapsed % this._beatIntervalMs) + this._beatIntervalMs) % this._beatIntervalMs
    return m / this._beatIntervalMs
  }

  /**
   * Signed ms from the nearest beat (negative = before, positive = after).
   * Range: roughly [-beatInterval/2, +beatInterval/2].
   * Returns `Infinity` if the clock hasn't started so tap-scoring can
   * treat that as "no beat to align with yet".
   */
  msFromNearestBeat(now = performance.now()): number {
    if (!this.started) return Number.POSITIVE_INFINITY
    const elapsed = now - this.perfStart
    const beat = Math.round(elapsed / this._beatIntervalMs)
    return elapsed - beat * this._beatIntervalMs
  }

  /** Integer beat index for a given perf time. */
  currentBeat(now = performance.now()): number {
    if (!this.started) return 0
    return Math.floor((now - this.perfStart) / this._beatIntervalMs)
  }

  /** Beat index nearest to a perf time (used for tap-to-note matching). */
  nearestBeatIndex(now = performance.now()): number {
    if (!this.started) return 0
    return Math.round((now - this.perfStart) / this._beatIntervalMs)
  }

  /** Perf-time at which a given beat index occurs (performance.now domain). */
  perfTimeOfBeat(beatIndex: number): number {
    return this.perfStart + beatIndex * this._beatIntervalMs
  }

  /** Smallest beat index whose perf time is strictly in the future. */
  nextBeatAfterPerf(now = performance.now()): number {
    if (!this.started) return 0
    return Math.max(0, Math.ceil((now - this.perfStart) / this._beatIntervalMs))
  }

  /** Convert a beat index to its scheduled audio-context time (seconds). */
  audioTimeOfBeat(beatIndex: number): number {
    return this.audioStart + beatIndex * this.beatIntervalSec
  }

  /** Smallest beat index whose scheduled audio time is in the future. */
  nextBeatAfter(audioNow: number): number {
    if (!this.started) return 0
    const elapsedAudio = audioNow - this.audioStart
    return Math.max(0, Math.ceil(elapsedAudio / this.beatIntervalSec))
  }
}
