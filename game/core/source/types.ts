export type TileType = 0 | 1

export interface InputState {
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

export interface PlayerState {
  x: number
  y: number
  rotation: number
}

export interface CoinState {
  id: string
  x: number
  y: number
}

export interface EnemyState {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

export type GameStatus = 'running' | 'won' | 'lost'

export interface GameState {
  tick: number
  running: boolean
  finished: boolean
  status: GameStatus
  score: number
  map: TileType[][]
  player: PlayerState
  coins: CoinState[]
  enemies: EnemyState[]
}

export interface GameConfig {
  mapWidth: number
  mapHeight: number
  tileSize: number
  tickIntervalMs: number
  wallChance: number
  coinCount: number
  enemyCount: number
  playerSpeed: number
  coinPickupRadius: number
  enemyHitRadius: number
}
