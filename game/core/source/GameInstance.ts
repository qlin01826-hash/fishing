import { DEFAULT_GAME_CONFIG } from './config.ts'
import type {
  CoinState,
  EnemyState,
  GameConfig,
  GameState,
  InputState,
  TileType,
} from './types.ts'

const ZERO_INPUT: InputState = {
  up: false,
  down: false,
  left: false,
  right: false,
}

export class GameInstance {
  readonly config: GameConfig

  private tickCount = 0
  private running = false
  private finished = false
  private input: InputState = { ...ZERO_INPUT }
  private readonly map: TileType[][]
  private player: GameState['player']
  private coins: CoinState[] = []
  private enemies: EnemyState[] = []
  private score = 0
  private coinSeq = 0
  private enemySeq = 0

  constructor(config: Partial<GameConfig> = {}) {
    this.config = { ...DEFAULT_GAME_CONFIG, ...config }
    this.map = this.generateMap()
    this.player = this.createPlayer()
    this.coins = this.createCoins(this.config.coinCount)
    this.enemies = this.createEnemies(this.config.enemyCount)
  }

  start(): void {
    this.running = true
  }

  stop(): void {
    this.running = false
  }

  applyInput(input: InputState): void {
    this.input = input
  }

  tick(): void {
    if (!this.running || this.finished) return

    this.tickCount += 1
    this.processPlayerMovement()
    this.processEnemies()
    this.processCollisions()
  }

  getState(): GameState {
    return {
      tick: this.tickCount,
      running: this.running,
      finished: this.finished,
      status: this.finished ? (this.coins.length === 0 ? 'won' : 'lost') : 'running',
      score: this.score,
      map: this.map,
      player: { ...this.player },
      coins: this.coins.map((coin) => ({ ...coin })),
      enemies: this.enemies.map((enemy) => ({ ...enemy })),
    }
  }

  private createPlayer(): GameState['player'] {
    const spawn = this.findEmptyTile()
    return {
      x: this.toWorld(spawn.x),
      y: this.toWorld(spawn.y),
      rotation: 0,
    }
  }

  private createCoins(count: number): CoinState[] {
    const coins: CoinState[] = []
    for (let index = 0; index < count; index += 1) {
      const pos = this.findEmptyTile([
        { x: this.player.x, y: this.player.y },
        ...coins,
        ...this.enemies,
      ])
      coins.push({
        id: `coin-${this.coinSeq++}`,
        x: this.toWorld(pos.x),
        y: this.toWorld(pos.y),
      })
    }
    return coins
  }

  private createEnemies(count: number): EnemyState[] {
    const enemies: EnemyState[] = []
    for (let index = 0; index < count; index += 1) {
      const pos = this.findEmptyTile([
        { x: this.player.x, y: this.player.y },
        ...this.coins,
        ...enemies,
      ])
      enemies.push({
        id: `enemy-${this.enemySeq++}`,
        x: this.toWorld(pos.x),
        y: this.toWorld(pos.y),
        vx: this.randomVelocity(),
        vy: this.randomVelocity(),
      })
    }
    return enemies
  }

  private processPlayerMovement(): void {
    const dirX = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0)
    const dirY = (this.input.down ? 1 : 0) - (this.input.up ? 1 : 0)
    if (dirX === 0 && dirY === 0) return

    const length = Math.hypot(dirX, dirY)
    const dt = this.config.tickIntervalMs / 1000
    const step = this.config.playerSpeed * dt
    const moveX = (dirX / length) * step
    const moveY = (dirY / length) * step
    const nextX = this.player.x + moveX
    const nextY = this.player.y + moveY

    if (this.isWallAt(nextX, nextY)) return

    this.player.x = nextX
    this.player.y = nextY
    this.player.rotation = Math.atan2(moveY, moveX) + Math.PI / 2
  }

  private processEnemies(): void {
    const dt = this.config.tickIntervalMs / 1000
    for (const enemy of this.enemies) {
      let nextX = enemy.x + enemy.vx * dt
      let nextY = enemy.y + enemy.vy * dt

      if (this.isWallAt(nextX, enemy.y)) {
        enemy.vx *= -1
        nextX = enemy.x
      }

      if (this.isWallAt(enemy.x, nextY)) {
        enemy.vy *= -1
        nextY = enemy.y
      }

      enemy.x = nextX
      enemy.y = nextY
    }
  }

  private processCollisions(): void {
    for (let index = this.coins.length - 1; index >= 0; index -= 1) {
      const coin = this.coins[index]
      if (distance(this.player.x, this.player.y, coin.x, coin.y) < this.config.coinPickupRadius) {
        this.score += 10
        this.coins.splice(index, 1)
      }
    }

    if (this.coins.length === 0) {
      this.finished = true
      this.running = false
      return
    }

    for (const enemy of this.enemies) {
      if (distance(this.player.x, this.player.y, enemy.x, enemy.y) < this.config.enemyHitRadius) {
        this.finished = true
        this.running = false
        return
      }
    }
  }

  private generateMap(): TileType[][] {
    const map: TileType[][] = []
    for (let y = 0; y < this.config.mapHeight; y += 1) {
      map[y] = []
      for (let x = 0; x < this.config.mapWidth; x += 1) {
        if (x === 0 || x === this.config.mapWidth - 1 || y === 0 || y === this.config.mapHeight - 1) {
          map[y][x] = 1
        } else if (Math.random() < this.config.wallChance) {
          map[y][x] = 1
        } else {
          map[y][x] = 0
        }
      }
    }

    const centerX = Math.floor(this.config.mapWidth / 2)
    const centerY = Math.floor(this.config.mapHeight / 2)
    for (let offsetY = -2; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -2; offsetX <= 1; offsetX += 1) {
        map[centerY + offsetY][centerX + offsetX] = 0
      }
    }

    return map
  }

  private findEmptyTile(
    occupiedEntities: Array<{ x: number; y: number }> = [],
  ): { x: number; y: number } {
    const occupied = new Set(
      occupiedEntities.map((entity) => `${this.toTile(entity.x)},${this.toTile(entity.y)}`),
    )

    let attempts = 0
    while (attempts < 100) {
      const x = Math.floor(Math.random() * (this.config.mapWidth - 2)) + 1
      const y = Math.floor(Math.random() * (this.config.mapHeight - 2)) + 1
      if (this.map[y][x] === 0 && !occupied.has(`${x},${y}`)) {
        return { x, y }
      }
      attempts += 1
    }

    return {
      x: Math.floor(this.config.mapWidth / 2),
      y: Math.floor(this.config.mapHeight / 2),
    }
  }

  private isWallAt(x: number, y: number): boolean {
    const tileX = this.toTile(x)
    const tileY = this.toTile(y)
    if (tileX < 0 || tileX >= this.config.mapWidth || tileY < 0 || tileY >= this.config.mapHeight) {
      return true
    }
    return this.map[tileY][tileX] === 1
  }

  private toWorld(tile: number): number {
    return tile * this.config.tileSize + this.config.tileSize / 2
  }

  private toTile(position: number): number {
    return Math.floor(position / this.config.tileSize)
  }

  private randomVelocity(): number {
    let velocity = 0
    while (Math.abs(velocity) < 20) {
      velocity = (Math.random() - 0.5) * 100
    }
    return velocity
  }
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}
