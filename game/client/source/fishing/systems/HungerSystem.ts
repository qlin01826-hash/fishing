import { FISHING_CONSTANTS } from '../types'

const STORAGE_KEY = 'penguin-fishing.hunger.v1'

interface PersistShape {
  hunger: number
  lastUpdate: number
  bestScore: number
}

/**
 * Tracks the penguin's hunger value (0..1).
 *
 * Hunger rises in real-time and PERSISTS across page reloads / sessions —
 * the spec's "故意不喂它"策略 needs this to feel like the penguin really
 * misses you while the tab is closed. We bake an offline catch-up at boot
 * by reading `lastUpdate` from localStorage.
 *
 * Also stores best score for the HUD.
 */
export class HungerSystem {
  private hunger = 0.4
  private bestScore = 0
  private lastSaveMs = 0
  private dirty = false

  constructor() {
    this.load()
  }

  /** Catch-up against real-world elapsed time. Call once after init. */
  applyOfflineGrowth(): void {
    const now = Date.now()
    const last = this.readLastUpdate(now)
    const deltaSeconds = Math.max(0, (now - last) / 1000)
    if (deltaSeconds > 0) {
      this.hunger = clamp01(this.hunger + deltaSeconds * FISHING_CONSTANTS.hungerPerSecond)
      this.dirty = true
      this.save(now)
    }
  }

  /** Realtime per-frame growth while playing. */
  update(dtSeconds: number, elapsedMs: number): void {
    this.hunger = clamp01(this.hunger + dtSeconds * FISHING_CONSTANTS.hungerPerSecond)
    if (elapsedMs - this.lastSaveMs > 2000 && this.dirty) {
      this.save(Date.now())
      this.lastSaveMs = elapsedMs
    }
  }

  feed(relief: number): void {
    this.hunger = clamp01(this.hunger - relief)
    this.dirty = true
    this.save(Date.now())
  }

  /** Force-set hunger (debug only). */
  setHunger(value: number): void {
    this.hunger = clamp01(value)
    this.dirty = true
  }

  getHunger(): number {
    return this.hunger
  }

  getBestScore(): number {
    return this.bestScore
  }

  reportScore(score: number): boolean {
    if (score > this.bestScore) {
      this.bestScore = score
      this.dirty = true
      this.save(Date.now())
      return true
    }
    return false
  }

  private readLastUpdate(now: number): number {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return now
      const parsed = JSON.parse(raw) as Partial<PersistShape>
      return typeof parsed.lastUpdate === 'number' ? parsed.lastUpdate : now
    } catch {
      return now
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<PersistShape>
      if (typeof parsed.hunger === 'number' && Number.isFinite(parsed.hunger)) {
        this.hunger = clamp01(parsed.hunger)
      }
      if (typeof parsed.bestScore === 'number' && Number.isFinite(parsed.bestScore)) {
        this.bestScore = Math.max(0, Math.floor(parsed.bestScore))
      }
    } catch {
      // localStorage may be unavailable in private mode; non-fatal
    }
  }

  private save(now: number): void {
    try {
      const payload: PersistShape = {
        hunger: this.hunger,
        lastUpdate: now,
        bestScore: this.bestScore,
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
      this.dirty = false
    } catch {
      // ignore
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < FISHING_CONSTANTS.minHunger) return FISHING_CONSTANTS.minHunger
  if (value > FISHING_CONSTANTS.maxHunger) return FISHING_CONSTANTS.maxHunger
  return value
}
