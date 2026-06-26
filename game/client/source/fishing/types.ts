/**
 * Shared types & constants for the fishing rhythm game.
 *
 * Coordinate system convention:
 * - Viewport coordinates: (0,0) top-left, x→right, y→down (Pixi default).
 * - WATER_LINE_Y is computed from viewportHeight at runtime; everything
 *   sky-side is < WATER_LINE_Y, underwater is >= WATER_LINE_Y.
 */

export type Direction = 'up' | 'down' | 'left' | 'right'

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'

/**
 * Physical size class — drives ambient-school sprite scale AND the
 * frenzy choreography:
 *   tiny/small  → surface dance, stand on tail, hop with the beat
 *   medium      → swim up to the shallow lane and sway, no standing
 *   large/huge  → stay submerged at their natural depth, bob up/down
 *                 vertically with each beat (too big to leap)
 */
export type FishSize = 'tiny' | 'small' | 'medium' | 'large' | 'huge'

/**
 * Silhouette shape — picked separately from size so e.g. a `large
 * torpedo` (tuna) and a `large flat` (ray) read very differently
 * even though both occupy the same vertical lane.
 */
export type FishBodyShape =
  | 'slim'     // sardine, mackerel — thin streamlined oval
  | 'torpedo'  // tuna, swordfish — muscular long oval + crescent tail
  | 'round'    // moonfish, pufferfish — disc/circle body
  | 'chunky'   // anglerfish — wide ugly body with big mouth
  | 'tentacle' // krakenling — body plus drooping arms
  | 'flat'     // ray — wide flat kite with trailing whip tail
  | 'arrow'    // shrimp/krill — small segmented arrow with antennae
  | 'bell'     // jellyfish — translucent dome with hanging strands

export interface FishDef {
  id: string
  i18nKey: string
  rarity: Rarity
  /** Physical scale tier — drives sprite size + frenzy choreography. */
  size: FishSize
  /** Silhouette family — drives drawFish() rendering branch. */
  bodyShape: FishBodyShape
  /** Score base when caught at calm weather. */
  baseScore: number
  /** 0..1 multiplier on hooked-window strictness. */
  strictness: number
  /** How many "follow fish" challenges the player must clear. */
  followLocks: number
  /** Initial fish willpower (the bar the player must drain). */
  willpower: number
  /** How aggressively the fish pushes the tension marker (0..1). */
  fightStrength: number
  /** Hex tint for catch banner & overlays. */
  color: number
  /** Minimum hook depth (in normalized 0..1 of available water depth). */
  minDepth: number
  /** Maximum hook depth (in normalized 0..1 of available water depth). */
  maxDepth: number
}

/** Wind tier: driven mainly by voyage depth; hunger adds a boost. */
export type WindTier = 'calm' | 'breeze' | 'strong' | 'storm'

export interface WeatherSnapshot {
  tier: WindTier
  /** Continuous 0..1 intensity from zone/voyage depth (+ hunger boost). */
  intensity: number
  /** Horizontal drift added to cast trajectories (px/s @ unit power). */
  windPush: number
  /** Multiplier applied to score / commission rewards. */
  rewardMultiplier: number
  /** Bonus probability of rare fish bites (0..1 added to base rates). */
  rareBoost: number
}

/** Layout context passed around for layout-aware UI/entities. */
export interface ViewportContext {
  width: number
  height: number
  /** Y coordinate of the horizon / water surface. */
  waterLineY: number
  /** Maximum depth from waterline to bottom of available water area. */
  maxDepth: number
}

/** State identifiers (kept as string literal union for ergonomic switching). */
export type FishingStateId =
  | 'sailing'
  | 'casting'
  | 'sinking'
  | 'waiting'
  | 'hooked'
  | 'battle'
  | 'catch'

/** Constants shared across the fishing game. */
export const FISHING_CONSTANTS = {
  /** Hunger increases per second of real-time elapsed. 0..1 scale. */
  hungerPerSecond: 1 / (60 * 8), // full hunger after ~8 minutes idle
  /** Penguin can't drop below this hunger floor. */
  minHunger: 0,
  /** Hunger is clamped to 1. */
  maxHunger: 1,
  /** How much hunger a successful commission catch relieves. */
  reliefBase: 0.35,
  /** Maximum power that drag charging can reach. */
  maxPower: 1,
  /** Pointer must stay still less than this many ms or charging resets. */
  charge_idle_ms: 200,
  /** Reel button can fire at most this often. */
  reel_throttle_ms: 1000 / 8,
  /** Hook nominal sink rate after water resistance kicks in (px/s). */
  hookSlowSinkSpeed: 18,
  /** Initial vertical impulse multiplier from power on hit-water. */
  splashImpulse: 720,
  /** Linear water drag (per second deceleration on hook velocity). */
  waterDrag: 1.8,
  /** How long the strike window stays open (ms). */
  strike_window_ms: 2500,
  /** Max time the player can be outside tension safe zone before snap (ms). */
  tension_grace_ms: 2000,
  /** Battle tick rate. */
  battle_tick_ms: 1000 / 60,
} as const

export type FishingConstants = typeof FISHING_CONSTANTS
