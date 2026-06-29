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
  private accumulatedBeats = 0

  /** True once `start()` has run (audio context unlocked). */
  started = false

  start(audioCurrentTimeSeconds: number, now = performance.now()): void {
    if (this.started) return
    this.perfStart = now
    this.audioStart = audioCurrentTimeSeconds
    this.accumulatedBeats = 0
    this.started = true
  }

  /**
   * Re-anchor the clock with a new BPM without breaking the current
   * beat's phase. Used when weather intensity shifts.
   */
  setBpm(bpm: number, audioCurrentTimeSeconds?: number): void {
    this.targetBpm = bpm
    if (!this.started) {
      this.bpm = bpm
      this._beatIntervalMs = 60_000 / bpm
      return
    }
    // Record current fractional beats at the old BPM before rebasing
    const now = performance.now()
    const elapsedPerfMs = now - this.perfStart
    const beatsSinceTransition = elapsedPerfMs / this._beatIntervalMs
    this.accumulatedBeats = this.accumulatedBeats + beatsSinceTransition
    
    this.perfStart = now
    if (audioCurrentTimeSeconds !== undefined) {
      this.audioStart = audioCurrentTimeSeconds
    } else {
      this.audioStart = this.audioStart + (elapsedPerfMs / 1000)
    }
    this.bpm = bpm
    this._beatIntervalMs = 60_000 / bpm
  }

  /**
   * Align the full rhythm grid to an audio-derived marker.
   *
   * `audioTimeOfBeatZero` is the AudioContext time at which beat index 0
   * should occur, usually "pack source start + parsed first downbeat offset".
   * This keeps visual timing and Web Audio scheduling on the same parsed grid
   * instead of assuming the MP3 starts exactly on beat 1.
   */
  alignToAudioGrid(
    bpm: number,
    audioTimeOfBeatZero: number,
    audioNow: number,
    now = performance.now(),
  ): void {
    this.targetBpm = bpm
    this.bpm = bpm
    this._beatIntervalMs = 60_000 / bpm
    this.perfStart = now
    this.audioStart = audioNow
    this.accumulatedBeats = (audioNow - audioTimeOfBeatZero) / this.beatIntervalSec
    this.started = true
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
    const beatsSinceTransition = elapsed / this._beatIntervalMs
    const absoluteBeat = this.accumulatedBeats + beatsSinceTransition
    return ((absoluteBeat % 1) + 1) % 1
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
    const beatsSinceTransition = elapsed / this._beatIntervalMs
    const absoluteBeat = this.accumulatedBeats + beatsSinceTransition
    const nearestBeat = Math.round(absoluteBeat)
    return (absoluteBeat - nearestBeat) * this._beatIntervalMs
  }

  /** Integer beat index for a given perf time. */
  currentBeat(now = performance.now()): number {
    if (!this.started) return 0
    const elapsed = now - this.perfStart
    const beatsSinceTransition = elapsed / this._beatIntervalMs
    return Math.floor(this.accumulatedBeats + beatsSinceTransition)
  }

  /** Beat index nearest to a perf time (used for tap-to-note matching). */
  nearestBeatIndex(now = performance.now()): number {
    if (!this.started) return 0
    const elapsed = now - this.perfStart
    const beatsSinceTransition = elapsed / this._beatIntervalMs
    return Math.round(this.accumulatedBeats + beatsSinceTransition)
  }

  /** Perf-time at which a given beat index occurs (performance.now domain). */
  perfTimeOfBeat(beatIndex: number): number {
    const beatsNeeded = beatIndex - this.accumulatedBeats
    return this.perfStart + beatsNeeded * this._beatIntervalMs
  }

  /** Smallest beat index whose perf time is strictly in the future. */
  nextBeatAfterPerf(now = performance.now()): number {
    if (!this.started) return 0
    const elapsed = now - this.perfStart
    const beatsSinceTransition = elapsed / this._beatIntervalMs
    return Math.max(0, Math.ceil(this.accumulatedBeats + beatsSinceTransition))
  }

  /** Convert a beat index to its scheduled audio-context time (seconds). */
  audioTimeOfBeat(beatIndex: number): number {
    const beatsNeeded = beatIndex - this.accumulatedBeats
    return this.audioStart + beatsNeeded * this.beatIntervalSec
  }

  /** Smallest beat index whose scheduled audio time is in the future. */
  nextBeatAfter(audioNow: number): number {
    if (!this.started) return 0
    const elapsedAudio = audioNow - this.audioStart
    const beatsSinceTransition = elapsedAudio / this.beatIntervalSec
    return Math.max(0, Math.ceil(this.accumulatedBeats + beatsSinceTransition))
  }
}
