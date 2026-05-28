export type {
  TileType,
  InputState,
  PlayerState,
  CoinState,
  EnemyState,
  GameStatus,
  GameState,
  GameConfig,
} from './types.ts'

export {
  TICK_INTERVAL_MS,
  MAP_WIDTH,
  MAP_HEIGHT,
  TILE_SIZE,
  PLAYER_SPEED,
  COIN_COUNT,
  ENEMY_COUNT,
  WALL_CHANCE,
  ENTITY_COLLISION_RADIUS,
  DEFAULT_GAME_CONFIG,
} from './config.ts'

export { GameInstance } from './GameInstance.ts'
