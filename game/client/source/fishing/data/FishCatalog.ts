import type { FishDef, WeatherSnapshot } from '../types'

/**
 * Fish catalogue.
 *
 * Rarities scale with hunger: when the weather is calm only the cheap fish
 * bite; as the storm grows the rare/epic/legendary tail unlocks.
 *
 * `i18nKey` resolves under `fish.<id>` in the locale files.
 */
export const FISH_CATALOG: readonly FishDef[] = [
  {
    id: 'sardine',
    i18nKey: 'sardine',
    rarity: 'common',
    baseScore: 10,
    strictness: 0.4,
    followLocks: 0,
    willpower: 40,
    fightStrength: 0.25,
    color: 0xb9d6f2,
    minDepth: 0.05,
    maxDepth: 0.35,
  },
  {
    id: 'mackerel',
    i18nKey: 'mackerel',
    rarity: 'uncommon',
    baseScore: 22,
    strictness: 0.55,
    followLocks: 1,
    willpower: 70,
    fightStrength: 0.4,
    color: 0x6fb6c8,
    minDepth: 0.2,
    maxDepth: 0.55,
  },
  {
    id: 'tuna',
    i18nKey: 'tuna',
    rarity: 'rare',
    baseScore: 55,
    strictness: 0.7,
    followLocks: 2,
    willpower: 120,
    fightStrength: 0.6,
    color: 0x315a8f,
    minDepth: 0.45,
    maxDepth: 0.85,
  },
  {
    id: 'anglerfish',
    i18nKey: 'anglerfish',
    rarity: 'epic',
    baseScore: 110,
    strictness: 0.82,
    followLocks: 3,
    willpower: 170,
    fightStrength: 0.75,
    color: 0x4a2b6b,
    minDepth: 0.65,
    maxDepth: 1.0,
  },
  {
    id: 'krakenling',
    i18nKey: 'krakenling',
    rarity: 'epic',
    baseScore: 140,
    strictness: 0.85,
    followLocks: 3,
    willpower: 200,
    fightStrength: 0.8,
    color: 0x8a3b2f,
    minDepth: 0.55,
    maxDepth: 0.95,
  },
  {
    id: 'moonfish',
    i18nKey: 'moonfish',
    rarity: 'legendary',
    baseScore: 260,
    strictness: 0.92,
    followLocks: 4,
    willpower: 280,
    fightStrength: 0.95,
    color: 0xf2d96e,
    minDepth: 0.7,
    maxDepth: 1.0,
  },
]

const RARITY_BASE_WEIGHTS: Record<FishDef['rarity'], number> = {
  common: 60,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 1,
}

/**
 * Choose a fish to bite. Higher weather intensity (= angrier penguin)
 * shifts the distribution toward rare species.
 */
export function pickFishForBite(
  weather: WeatherSnapshot,
  depth01: number,
  rng: () => number,
): FishDef {
  const eligible = FISH_CATALOG.filter(
    (fish) => depth01 >= fish.minDepth && depth01 <= fish.maxDepth,
  )
  const pool = eligible.length > 0 ? eligible : [...FISH_CATALOG]
  const boost = weather.rareBoost
  const weights = pool.map((fish) => {
    const base = RARITY_BASE_WEIGHTS[fish.rarity]
    switch (fish.rarity) {
      case 'common':
        return base * Math.max(0.15, 1 - boost * 1.4)
      case 'uncommon':
        return base * (1 - boost * 0.4)
      case 'rare':
        return base * (1 + boost * 1.6)
      case 'epic':
        return base * (1 + boost * 3.5)
      case 'legendary':
        return base * (1 + boost * 6)
    }
  })
  const total = weights.reduce((sum, value) => sum + value, 0)
  let roll = rng() * total
  for (let index = 0; index < pool.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return pool[index]
  }
  return pool[pool.length - 1]
}

/** Pick what the penguin asks for: bias toward rarer fish when hungry. */
export function pickCommissionFish(hunger: number, rng: () => number): FishDef {
  const desire = Math.min(1, Math.max(0, hunger))
  const weights = FISH_CATALOG.map((fish) => {
    const base = RARITY_BASE_WEIGHTS[fish.rarity]
    switch (fish.rarity) {
      case 'common':
        return base * (1 - desire * 0.7)
      case 'uncommon':
        return base * (1 - desire * 0.2)
      case 'rare':
        return base * (1 + desire * 1.2)
      case 'epic':
        return base * (1 + desire * 2.5)
      case 'legendary':
        return base * (1 + desire * 5)
    }
  })
  const total = weights.reduce((sum, value) => sum + value, 0)
  let roll = rng() * total
  for (let index = 0; index < FISH_CATALOG.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return FISH_CATALOG[index]
  }
  return FISH_CATALOG[0]
}

export function rarityToColor(rarity: FishDef['rarity']): number {
  switch (rarity) {
    case 'common':
      return 0xb9b9b9
    case 'uncommon':
      return 0x7fd99c
    case 'rare':
      return 0x6fb1ff
    case 'epic':
      return 0xc580ff
    case 'legendary':
      return 0xffc34d
  }
}
