import type { WeatherSnapshot, WindTier } from '../types'

/**
 * Converts hunger (0..1) into a weather snapshot that other systems read.
 *
 * The breakpoints follow the spec:
 *   < 30%  : calm, normal fish
 *   30-60% : breeze, parabola starts to drift
 *   60-85% : strong wind, rare boost up
 *   > 85%  : storm, double rewards
 *
 * `intensity` is a smooth 0..1 mapping (good for visual interpolation —
 * wave amplitude, audio gain, etc.); `tier` is a discrete bucket for UI
 * labels and reward math.
 */
export class WeatherSystem {
  private snapshot: WeatherSnapshot = makeSnapshot(0)

  update(hunger: number): void {
    this.snapshot = makeSnapshot(hunger)
  }

  get(): WeatherSnapshot {
    return this.snapshot
  }
}

function makeSnapshot(hunger: number): WeatherSnapshot {
  const tier = bucket(hunger)
  const intensity = curve(hunger)
  return {
    tier,
    intensity,
    windPush: 90 * intensity,
    rewardMultiplier: tier === 'storm' ? 2 : tier === 'strong' ? 1.4 : tier === 'breeze' ? 1.1 : 1,
    rareBoost: intensity,
  }
}

function bucket(hunger: number): WindTier {
  if (hunger < 0.3) return 'calm'
  if (hunger < 0.6) return 'breeze'
  if (hunger < 0.85) return 'strong'
  return 'storm'
}

function curve(hunger: number): number {
  // Smooth-step that under-weights the calm zone and ramps up past 0.6
  const clamped = Math.max(0, Math.min(1, hunger))
  return clamped * clamped * (3 - 2 * clamped)
}
