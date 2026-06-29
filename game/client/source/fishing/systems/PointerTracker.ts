/**
 * Single-pointer drag tracker that records a short history of recent
 * samples so we can compute *instantaneous* velocity (px/s) rather than
 * average-since-pointerdown.
 *
 * This is needed because the cast spec is:
 *   power = swipe speed + sustained duration  (NOT distance dragged)
 *   freezing the finger for 200ms zeroes the charge
 *
 * The tracker is also used by the battle "fish running" reactive swipe.
 * It does NOT bind any DOM listeners itself — `FishingScene` forwards
 * raw pointer events via `pointerDown/Move/Up`.
 */

const HISTORY_MS = 120

interface Sample {
  x: number
  y: number
  t: number
}

export class PointerTracker {
  /** Currently captured pointer (only single-touch supported on purpose). */
  pointerId: number | null = null
  /** True between pointerdown and pointerup of the captured pointer. */
  active = false
  /** Latest known position. */
  x = 0
  y = 0
  /** Position at the most recent pointerdown. */
  startX = 0
  startY = 0
  /** Timestamp (ms) of the most recent pointerdown. */
  startTime = 0

  private history: Sample[] = []

  pointerDown(x: number, y: number, pointerId: number, time: number): void {
    if (this.active) return
    this.pointerId = pointerId
    this.active = true
    this.x = this.startX = x
    this.y = this.startY = y
    this.startTime = time
    this.history.length = 0
    this.history.push({ x, y, t: time })
  }

  pointerMove(x: number, y: number, pointerId: number, time: number): void {
    if (!this.active || pointerId !== this.pointerId) return
    this.x = x
    this.y = y
    this.history.push({ x, y, t: time })
    while (this.history.length > 1 && time - this.history[0].t > HISTORY_MS) {
      this.history.shift()
    }
  }

  pointerUp(pointerId: number): void {
    if (pointerId !== this.pointerId) return
    this.active = false
    this.pointerId = null
  }

  /** Reset state (e.g. when leaving a state mid-drag). */
  reset(): void {
    this.active = false
    this.pointerId = null
    this.history.length = 0
  }

  /** Vector from press point to current point. */
  totalDelta(): { dx: number; dy: number } {
    return { dx: this.x - this.startX, dy: this.y - this.startY }
  }

  /** Average speed (px/s) over the last `HISTORY_MS` of samples. */
  instantSpeed(now: number): number {
    if (this.history.length < 2) return 0
    const head = this.history[0]
    let dx = 0
    let dy = 0
    for (let i = 1; i < this.history.length; i += 1) {
      dx += this.history[i].x - this.history[i - 1].x
      dy += this.history[i].y - this.history[i - 1].y
    }
    const dt = Math.max(1, (this.history[this.history.length - 1].t - head.t))
    const dist = Math.hypot(dx, dy)
    // Bias slightly toward how recently we got the sample to feel snappy
    void now
    return (dist / dt) * 1000
  }

  /** Time since the last sample was added (ms). */
  msSinceLastSample(now: number): number {
    if (this.history.length === 0) return Infinity
    return now - this.history[this.history.length - 1].t
  }

  /** Time held down (ms). */
  heldFor(now: number): number {
    return this.active ? now - this.startTime : 0
  }

  /** Direction of total drag (unit vector). */
  direction(): { x: number; y: number } {
    const { dx, dy } = this.totalDelta()
    const len = Math.hypot(dx, dy)
    if (len < 1e-3) return { x: 0, y: 0 }
    return { x: dx / len, y: dy / len }
  }
}
