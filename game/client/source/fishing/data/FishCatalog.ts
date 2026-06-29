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
  // ---- Tiny shallow critters ----
  {
    id: 'shrimp',
    i18nKey: 'shrimp',
    rarity: 'common',
    size: 'tiny',
    bodyShape: 'arrow',
    baseScore: 6,
    strictness: 0.3,
    followLocks: 0,
    willpower: 24,
    fightStrength: 0.15,
    color: 0xff8a72,
    minDepth: 0.02,
    maxDepth: 0.25,
  },
  {
    id: 'sardine',
    i18nKey: 'sardine',
    rarity: 'common',
    size: 'tiny',
    bodyShape: 'slim',
    baseScore: 10,
    strictness: 0.4,
    followLocks: 0,
    willpower: 40,
    fightStrength: 0.25,
    color: 0xb9d6f2,
    minDepth: 0.05,
    maxDepth: 0.35,
  },
  // ---- Small mid-water ----
  {
    id: 'mackerel',
    i18nKey: 'mackerel',
    rarity: 'uncommon',
    size: 'small',
    bodyShape: 'slim',
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
    id: 'pufferfish',
    i18nKey: 'pufferfish',
    rarity: 'uncommon',
    size: 'small',
    bodyShape: 'round',
    baseScore: 30,
    strictness: 0.6,
    followLocks: 1,
    willpower: 85,
    fightStrength: 0.45,
    color: 0xffc873,
    minDepth: 0.15,
    maxDepth: 0.5,
  },
  // ---- Medium ----
  {
    id: 'jellyfish',
    i18nKey: 'jellyfish',
    rarity: 'rare',
    size: 'medium',
    bodyShape: 'bell',
    baseScore: 40,
    strictness: 0.6,
    followLocks: 1,
    willpower: 90,
    fightStrength: 0.35,
    color: 0xe3b7ff,
    minDepth: 0.3,
    maxDepth: 0.7,
  },
  {
    id: 'anglerfish',
    i18nKey: 'anglerfish',
    rarity: 'epic',
    size: 'medium',
    bodyShape: 'chunky',
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
    size: 'medium',
    bodyShape: 'tentacle',
    baseScore: 140,
    strictness: 0.85,
    followLocks: 3,
    willpower: 200,
    fightStrength: 0.8,
    color: 0x8a3b2f,
    minDepth: 0.55,
    maxDepth: 0.95,
  },
  // ---- Large ----
  {
    id: 'tuna',
    i18nKey: 'tuna',
    rarity: 'rare',
    size: 'large',
    bodyShape: 'torpedo',
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
    id: 'swordfish',
    i18nKey: 'swordfish',
    rarity: 'epic',
    size: 'large',
    bodyShape: 'torpedo',
    baseScore: 160,
    strictness: 0.85,
    followLocks: 3,
    willpower: 210,
    fightStrength: 0.85,
    color: 0x4a6b8a,
    minDepth: 0.5,
    maxDepth: 0.9,
    // Distinguished from tuna at render time by its long bill (see drawFish).
  },
  // ---- Huge ----
  {
    id: 'ray',
    i18nKey: 'ray',
    rarity: 'rare',
    size: 'huge',
    bodyShape: 'flat',
    baseScore: 80,
    strictness: 0.7,
    followLocks: 2,
    willpower: 150,
    fightStrength: 0.55,
    color: 0x4a4a5a,
    minDepth: 0.4,
    maxDepth: 0.85,
  },
  {
    id: 'moonfish',
    i18nKey: 'moonfish',
    rarity: 'legendary',
    size: 'huge',
    bodyShape: 'round',
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

/** Shallowest depth band (0..1) each named zone allows for ambient spawns. */
const ZONE_MIN_SPAWN_DEPTH = [0, 0.08, 0.22, 0.42, 0.62] as const
/** Deepest depth band each zone exposes — beach shallows stay very thin. */
const ZONE_MAX_SPAWN_DEPTH = [0.32, 0.52, 0.72, 0.9, 1.0] as const

/** Fish species eligible for the current zone and water-column slice. */
export function fishEligibleForZone(zone: number, depth01: number): FishDef[] {
  const z = Math.max(0, Math.min(ZONE_MAX_SPAWN_DEPTH.length - 1, zone))
  const bandMin = ZONE_MIN_SPAWN_DEPTH[z]
  const bandMax = ZONE_MAX_SPAWN_DEPTH[z]
  if (depth01 < bandMin || depth01 > bandMax) return []
  return FISH_CATALOG.filter(
    (fish) =>
      depth01 >= fish.minDepth &&
      depth01 <= fish.maxDepth &&
      fish.minDepth <= bandMax &&
      fish.maxDepth >= bandMin,
  )
}

/**
 * Choose a fish to bite. Higher weather intensity (= angrier penguin)
 * shifts the distribution toward rare species.
 */
export function pickFishForBite(
  weather: WeatherSnapshot,
  depth01: number,
  rng: () => number,
  extraRareBoost = 0,
  zone = 0,
): FishDef {
  const eligible = fishEligibleForZone(zone, depth01)
  const pool = eligible.length > 0 ? eligible : fishEligibleForZone(zone, Math.min(0.25, depth01))
  const fallback = pool.length > 0 ? pool : [...FISH_CATALOG]
  // Stage adds on top of the weather's rare bias so deeper runs throw
  // rarer (and thus tougher) species at the player.
  const boost = Math.min(1.5, weather.rareBoost + Math.max(0, extraRareBoost))
  const weights = fallback.map((fish) => {
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
  for (let index = 0; index < fallback.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return fallback[index]
  }
  return fallback[fallback.length - 1] ?? FISH_CATALOG[0]
}

/** Pick what the penguin asks for — biased by hunger and current zone. */
export function pickCommissionFish(hunger: number, rng: () => number, zone = 0): FishDef {
  const desire = Math.min(1, Math.max(0, hunger))
  const z = Math.max(0, Math.min(ZONE_MAX_SPAWN_DEPTH.length - 1, zone))
  const bandMax = ZONE_MAX_SPAWN_DEPTH[z]
  const zoneFish = FISH_CATALOG.filter((f) => f.minDepth <= bandMax && f.maxDepth >= ZONE_MIN_SPAWN_DEPTH[z])
  const catalog = zoneFish.length > 0 ? zoneFish : [...FISH_CATALOG]
  const weights = catalog.map((fish) => {
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
  for (let index = 0; index < catalog.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return catalog[index]
  }
  return catalog[0]
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
