import type { WeatherSnapshot, WindTier } from '../types'

/**
 * Weather is driven primarily by how deep the voyage has sailed (zone +
 * voyage progress). Penguin hunger adds a smaller boost on top.
 *
 * Shallows: calm → breeze at most (unless starving).
 * Deep / abyss: strong wind and storms become the baseline.
 */
export class WeatherSystem {
  private snapshot: WeatherSnapshot = makeSnapshot(0, 0, 0)

  update(hunger: number, voyageT: number, zone: number): void {
    this.snapshot = makeSnapshot(hunger, voyageT, zone)
  }

  get(): WeatherSnapshot {
    return this.snapshot
  }
}

function makeSnapshot(hunger: number, voyageT: number, zone: number): WeatherSnapshot {
  const v = Math.max(0, Math.min(1, voyageT))
  const z = Math.max(0, Math.min(4, zone)) / 4
  const zoneBase = z * 0.5 + v * 0.42
  const hungerBoost = hungerCurve(hunger) * 0.28
  const intensity = clamp01(zoneBase + hungerBoost)
  const tier = bucketFromIntensity(intensity)
  return {
    tier,
    intensity,
    windPush: 35 + intensity * 110,
    rewardMultiplier:
      tier === 'storm' ? 2 : tier === 'strong' ? 1.4 : tier === 'breeze' ? 1.1 : 1,
    rareBoost: intensity,
  }
}

function bucketFromIntensity(intensity: number): WindTier {
  if (intensity < 0.22) return 'calm'
  if (intensity < 0.48) return 'breeze'
  if (intensity < 0.74) return 'strong'
  return 'storm'
}

function hungerCurve(hunger: number): number {
  const clamped = Math.max(0, Math.min(1, hunger))
  return clamped * clamped * (3 - 2 * clamped)
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
