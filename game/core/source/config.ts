import type { GameConfig } from './types.ts'

export const TICK_INTERVAL_MS = 1000 / 60
export const MAP_WIDTH = 20
export const MAP_HEIGHT = 15
export const TILE_SIZE = 32

export const PLAYER_SPEED = 200
export const COIN_COUNT = 10
export const ENEMY_COUNT = 3
export const WALL_CHANCE = 0.1
export const ENTITY_COLLISION_RADIUS = TILE_SIZE / 2

export const DEFAULT_GAME_CONFIG: GameConfig = {
  mapWidth: MAP_WIDTH,
  mapHeight: MAP_HEIGHT,
  tileSize: TILE_SIZE,
  tickIntervalMs: TICK_INTERVAL_MS,
  wallChance: WALL_CHANCE,
  coinCount: COIN_COUNT,
  enemyCount: ENEMY_COUNT,
  playerSpeed: PLAYER_SPEED,
  coinPickupRadius: ENTITY_COLLISION_RADIUS,
  enemyHitRadius: ENTITY_COLLISION_RADIUS,
}
