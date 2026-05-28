import { Container, Graphics, Text, TextStyle } from 'pixi.js'
import { t } from '@minigame/i18n'
import {
  DEFAULT_GAME_CONFIG,
  GameInstance,
  type CoinState,
  type GameState,
  type InputState,
} from '@minigame/core'
import { PlatformInput, detectPlatform } from '@minigame/platform'
import type { GameScene } from '../engine/Engine'
import { Engine } from '../engine/Engine'

const COLORS = {
  grass: 0x7cc85d,
  bushA: 0x478734,
  bushB: 0x5d9e42,
  beeYellow: 0xf5c800,
  beeDark: 0x2f1a00,
  wing: 0xdff6ff,
  enemy: 0xd95b5b,
  enemyShell: 0xc64545,
  enemyHead: 0x422214,
  enemySpot: 0x2c0f0f,
  stem: 0x3b9d43,
  flowerCenter: 0xf7c844,
  signBoard: 0xd8a96d,
  signShadow: 0x8a5b39,
  signPost: 0x7f512f,
} as const

type WingPair = [Graphics, Graphics]

interface RenderPlayer {
  sprite: Container
  wings: WingPair
}

interface RenderCoin {
  sprite: Container
  phase: number
}

export class MainScene implements GameScene {
  private readonly engine: Engine
  private readonly worldContainer = new Container()
  private readonly mapContainer = new Container()
  private readonly entityContainer = new Container()
  private readonly uiContainer = new Container()

  private game: GameInstance | null = null
  private state: GameState | null = null
  private player: RenderPlayer | null = null
  private readonly coinSprites = new Map<string, RenderCoin>()
  private readonly enemySprites = new Map<string, Container>()

  private platformInput: PlatformInput | null = null
  private scoreText: Text | null = null
  private helpText: Text | null = null
  private messageText: Text | null = null
  private lastStatus: GameState['status'] | null = null
  private lastScore = 0
  private elapsedMs = 0
  private accumulatorMs = 0
  private viewportWidth = 1
  private viewportHeight = 1

  constructor(engine: Engine) {
    this.engine = engine
    this.worldContainer.addChild(this.mapContainer)
    this.worldContainer.addChild(this.entityContainer)
    this.engine.app.stage.addChild(this.worldContainer)
    this.engine.app.stage.addChild(this.uiContainer)
  }

  init(): void {
    this.resetContainers()
    this.coinSprites.clear()
    this.enemySprites.clear()
    this.player = null
    this.scoreText = null
    this.helpText = null
    this.messageText = null
    this.lastStatus = null
    this.lastScore = 0
    this.elapsedMs = 0
    this.accumulatorMs = 0

    this.platformInput = new PlatformInput({
      mode: 'joystick',
      canvas: this.engine.app.canvas,
    })

    this.game = new GameInstance()
    this.game.start()
    this.state = this.game.getState()

    this.drawMap(this.state)
    this.createPlayerRender()
    this.syncState(this.state)
    this.createUI()
    this.onResize(this.engine.app.renderer.width, this.engine.app.renderer.height)
  }

  update(deltaSeconds: number): void {
    this.elapsedMs += deltaSeconds * 1000

    if (this.game && this.state && !this.state.finished) {
      this.game.applyInput(this.readInputState())
      this.accumulatorMs += deltaSeconds * 1000

      while (this.accumulatorMs >= this.game.config.tickIntervalMs) {
        this.game.tick()
        this.accumulatorMs -= this.game.config.tickIntervalMs
      }

      this.state = this.game.getState()
    }

    if (this.state) {
      this.syncState(this.state)
      this.updateAmbientAnimation(this.elapsedMs, this.state)
      this.updateCamera(this.state)
    }

    this.platformInput?.endFrame()
  }

  onResize(width: number, height: number): void {
    this.viewportWidth = width
    this.viewportHeight = height
    this.layoutUi()

    if (this.state) {
      this.updateCamera(this.state)
    }
  }

  destroy(): void {
    this.platformInput?.dispose()
    this.platformInput = null
    this.game?.stop()
    this.game = null
    this.state = null
    this.player = null
    this.coinSprites.clear()
    this.enemySprites.clear()
    this.resetContainers()
    this.scoreText = null
    this.helpText = null
    this.messageText = null
    this.lastStatus = null
  }

  private resetContainers(): void {
    this.destroyChildren(this.mapContainer)
    this.destroyChildren(this.entityContainer)
    this.destroyChildren(this.uiContainer)
  }

  private destroyChildren(container: Container): void {
    const children = container.removeChildren()
    for (const child of children) {
      child.destroy({ children: true })
    }
  }

  private readInputState(): InputState {
    const raw = this.platformInput?.getInput()
    const threshold = 0.3
    const input = this.engine.input

    return {
      left: (raw?.moveX ?? 0) < -threshold || input.isKeyDown('arrowleft') || input.isKeyDown('a'),
      right: (raw?.moveX ?? 0) > threshold || input.isKeyDown('arrowright') || input.isKeyDown('d'),
      up: (raw?.moveY ?? 0) < -threshold || input.isKeyDown('arrowup') || input.isKeyDown('w'),
      down: (raw?.moveY ?? 0) > threshold || input.isKeyDown('arrowdown') || input.isKeyDown('s'),
    }
  }

  private syncState(state: GameState): void {
    this.syncPlayer(state)
    this.syncCoins(state.coins)
    this.syncEnemies(state)
    this.syncHud(state)
    this.syncStatus(state)
  }

  private syncPlayer(state: GameState): void {
    if (!this.player) {
      this.createPlayerRender()
    }

    if (!this.player) return

    this.player.sprite.position.set(state.player.x, state.player.y)
    this.player.sprite.rotation = state.player.rotation
  }

  private syncCoins(coins: CoinState[]): void {
    const activeIds = new Set(coins.map((coin) => coin.id))

    for (const [coinId, renderCoin] of this.coinSprites) {
      if (!activeIds.has(coinId)) {
        renderCoin.sprite.removeFromParent()
        renderCoin.sprite.destroy({ children: true })
        this.coinSprites.delete(coinId)
      }
    }

    for (const coin of coins) {
      let renderCoin = this.coinSprites.get(coin.id)
      if (!renderCoin) {
        renderCoin = {
          sprite: this.createFlowerSprite(),
          phase: Math.random() * Math.PI * 2,
        }
        this.entityContainer.addChild(renderCoin.sprite)
        this.coinSprites.set(coin.id, renderCoin)
      }
      renderCoin.sprite.position.set(coin.x, coin.y)
    }
  }

  private syncEnemies(state: GameState): void {
    const activeIds = new Set(state.enemies.map((enemy) => enemy.id))

    for (const [enemyId, sprite] of this.enemySprites) {
      if (!activeIds.has(enemyId)) {
        sprite.removeFromParent()
        sprite.destroy({ children: true })
        this.enemySprites.delete(enemyId)
      }
    }

    for (const enemy of state.enemies) {
      let sprite = this.enemySprites.get(enemy.id)
      if (!sprite) {
        sprite = this.createEnemySprite()
        this.entityContainer.addChild(sprite)
        this.enemySprites.set(enemy.id, sprite)
      }
      sprite.position.set(enemy.x, enemy.y)
    }
  }

  private syncHud(state: GameState): void {
    if (this.scoreText && state.score !== this.lastScore) {
      this.scoreText.text = t('game.score', { score: String(state.score) })
      this.lastScore = state.score
    }
  }

  private syncStatus(state: GameState): void {
    if (!this.player) return

    if (state.status === 'lost') {
      this.player.sprite.alpha = 0.65
      this.player.sprite.scale.set(0.94)
    } else {
      this.player.sprite.alpha = 1
      this.player.sprite.scale.set(1)
    }

    if (this.lastStatus === state.status) {
      return
    }

    const previousStatus = this.lastStatus
    this.lastStatus = state.status

    if (previousStatus === null || state.status === 'running') {
      return
    }

    if (state.status === 'won') {
      this.showMessage(t('game.youWin'))
    } else if (state.status === 'lost') {
      this.showMessage(t('game.gameOver'))
    }
  }

  private drawMap(state: GameState): void {
    const tileSize = this.getTileSize()

    for (let y = 0; y < state.map.length; y += 1) {
      for (let x = 0; x < state.map[y].length; x += 1) {
        const px = x * tileSize + tileSize / 2
        const py = y * tileSize + tileSize / 2

        if (state.map[y][x] === 1) {
          const wall = (x + y) % 4 === 0 ? this.createSignboard() : this.createBush()
          wall.position.set(px, py)
          this.mapContainer.addChild(wall)
        } else {
          const floor = new Graphics()
          floor.rect(-tileSize / 2, -tileSize / 2, tileSize - 1, tileSize - 1)
          floor.fill(COLORS.grass)
          floor.position.set(px, py)
          this.mapContainer.addChild(floor)
        }
      }
    }
  }

  private createPlayerRender(): void {
    const { container, wings } = this.createBeeSprite(COLORS.beeYellow)
    this.entityContainer.addChild(container)
    this.player = { sprite: container, wings }
  }

  private createUI(): void {
    const platform = detectPlatform()
    const helpMsg = platform === 'mobile' ? t('game.helpMobile') : t('game.helpDesktop')

    this.scoreText = new Text({
      text: t('game.score', { score: '0' }),
      style: new TextStyle({
        fontSize: 24,
        fontFamily: 'Arial, sans-serif',
        fill: '#5b2f00',
      }),
    })
    this.helpText = new Text({
      text: helpMsg,
      style: new TextStyle({
        fontSize: 14,
        fontFamily: 'Arial, sans-serif',
        fill: '#fff8e2',
      }),
    })

    const scorePanel = this.createPanel(this.scoreText, 12, 8, 0xf6d28f, 0.95)
    const helpPanel = this.createPanel(this.helpText, 8, 6, 0x6b4321, 0.72)

    this.uiContainer.addChild(scorePanel)
    this.uiContainer.addChild(helpPanel)

    scorePanel.label = 'score-panel'
    helpPanel.label = 'help-panel'

    this.layoutUi()
  }

  private createPanel(text: Text, paddingX: number, paddingY: number, fill: number, alpha: number): Container {
    const panel = new Container()
    const background = new Graphics()
    const width = text.width + paddingX * 2
    const height = text.height + paddingY * 2

    background.roundRect(0, 0, width, height, 10)
    background.fill({ color: fill, alpha })
    text.position.set(paddingX, paddingY)

    panel.addChild(background)
    panel.addChild(text)

    return panel
  }

  private layoutUi(): void {
    const scorePanel = this.uiContainer.getChildByLabel('score-panel')
    const helpPanel = this.uiContainer.getChildByLabel('help-panel')

    if (scorePanel) {
      scorePanel.position.set(10, 10)
    }

    if (helpPanel) {
      helpPanel.position.set(10, 58)
    }

    const messagePanel = this.uiContainer.getChildByLabel('message-panel')
    if (messagePanel) {
      messagePanel.position.set(this.viewportWidth / 2, this.viewportHeight / 2)
    }
  }

  private showMessage(text: string): void {
    const existing = this.uiContainer.getChildByLabel('message-panel')
    if (existing) {
      existing.removeFromParent()
      existing.destroy({ children: true })
    }

    this.messageText = new Text({
      text,
      style: new TextStyle({
        fontSize: 32,
        fontFamily: 'Arial, sans-serif',
        fill: '#5b2f00',
        align: 'center',
      }),
    })
    this.messageText.anchor.set(0.5)

    const background = new Graphics()
    background.roundRect(
      -(this.messageText.width / 2) - 20,
      -(this.messageText.height / 2) - 15,
      this.messageText.width + 40,
      this.messageText.height + 30,
      14,
    )
    background.fill({ color: 0xf6d28f, alpha: 0.82 })

    const messageContainer = new Container()
    messageContainer.label = 'message-panel'
    messageContainer.addChild(background)
    messageContainer.addChild(this.messageText)
    messageContainer.position.set(this.viewportWidth / 2, this.viewportHeight / 2)

    this.uiContainer.addChild(messageContainer)
  }

  private updateAmbientAnimation(time: number, state: GameState): void {
    if (this.player) {
      const flap = Math.sin(time * 0.03) * (Math.PI / 15)
      this.player.wings[0].rotation = -0.4 - flap
      this.player.wings[1].rotation = 0.4 + flap
    }

    for (const coin of state.coins) {
      const renderCoin = this.coinSprites.get(coin.id)
      if (!renderCoin) continue

      renderCoin.sprite.position.set(
        coin.x,
        coin.y - 6 + Math.sin(time * 0.004 + renderCoin.phase) * 3,
      )
      renderCoin.sprite.rotation = Math.sin(time * 0.002 + renderCoin.phase) * 0.08
    }
  }

  private updateCamera(state: GameState): void {
    const tileSize = this.getTileSize()
    const mapWidthPx = state.map[0].length * tileSize
    const mapHeightPx = state.map.length * tileSize

    let targetX = this.viewportWidth / 2 - state.player.x
    let targetY = this.viewportHeight / 2 - state.player.y

    if (mapWidthPx <= this.viewportWidth) {
      targetX = (this.viewportWidth - mapWidthPx) / 2
    } else {
      targetX = this.clamp(targetX, this.viewportWidth - mapWidthPx, 0)
    }

    if (mapHeightPx <= this.viewportHeight) {
      targetY = (this.viewportHeight - mapHeightPx) / 2
    } else {
      targetY = this.clamp(targetY, this.viewportHeight - mapHeightPx, 0)
    }

    this.worldContainer.position.set(targetX, targetY)
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
  }

  private getTileSize(): number {
    return this.game?.config.tileSize ?? DEFAULT_GAME_CONFIG.tileSize
  }

  private createBeeSprite(bodyColor: number): { container: Container; wings: WingPair } {
    const container = new Container()

    const wingLeft = new Graphics()
    wingLeft.ellipse(0, 0, 8, 12)
    wingLeft.fill({ color: COLORS.wing, alpha: 0.75 })
    wingLeft.position.set(-7, -8)
    wingLeft.rotation = -0.4

    const wingRight = new Graphics()
    wingRight.ellipse(0, 0, 8, 12)
    wingRight.fill({ color: COLORS.wing, alpha: 0.75 })
    wingRight.position.set(7, -8)
    wingRight.rotation = 0.4

    container.addChild(wingLeft, wingRight)

    const bodyRear = new Graphics()
    bodyRear.ellipse(0, 5, 10, 6)
    bodyRear.fill(bodyColor)

    const stripe1 = new Graphics()
    stripe1.rect(-9, -1, 18, 4)
    stripe1.fill(COLORS.beeDark)

    const bodyMid = new Graphics()
    bodyMid.ellipse(0, -1, 11, 6)
    bodyMid.fill(bodyColor)

    const stripe2 = new Graphics()
    stripe2.rect(-8, -8, 16, 4)
    stripe2.fill(COLORS.beeDark)

    const bodyFront = new Graphics()
    bodyFront.ellipse(0, -10, 9, 5)
    bodyFront.fill(bodyColor)

    const head = new Graphics()
    head.circle(0, -14, 7)
    head.fill(COLORS.beeDark)

    const eyeLeft = new Graphics()
    eyeLeft.circle(-3, -15, 1.6)
    eyeLeft.fill(0xffffff)

    const eyeRight = new Graphics()
    eyeRight.circle(3, -15, 1.6)
    eyeRight.fill(0xffffff)

    const stinger = new Graphics()
    stinger.poly([0, 15, -4, 23, 4, 23])
    stinger.fill(COLORS.beeDark)

    container.addChild(
      bodyRear,
      stripe1,
      bodyMid,
      stripe2,
      bodyFront,
      head,
      eyeLeft,
      eyeRight,
      stinger,
    )

    return { container, wings: [wingLeft, wingRight] }
  }

  private createFlowerSprite(): Container {
    const container = new Container()
    const petals = [0xff6fae, 0xffcf4d, 0xffffff, 0xc595ff, 0xff8a65]
    const petalColor = petals[Math.floor(Math.random() * petals.length)]

    const stem = new Graphics()
    stem.rect(-1.5, 4, 3, 12)
    stem.fill(COLORS.stem)
    container.addChild(stem)

    const positions: Array<[number, number]> = [
      [0, -2],
      [-5, 2],
      [5, 2],
      [-3, 7],
      [3, 7],
    ]

    for (const [px, py] of positions) {
      const petal = new Graphics()
      petal.circle(px, py, 5)
      petal.fill(petalColor)
      container.addChild(petal)
    }

    const center = new Graphics()
    center.circle(0, 4, 4.5)
    center.fill(COLORS.flowerCenter)
    container.addChild(center)

    return container
  }

  private createEnemySprite(): Container {
    const container = new Container()

    const body = new Graphics()
    body.ellipse(0, 0, 10, 12)
    body.fill(COLORS.enemy)

    const shell = new Graphics()
    shell.ellipse(0, 1, 8, 9)
    shell.fill(COLORS.enemyShell)

    const head = new Graphics()
    head.circle(0, -10, 6)
    head.fill(COLORS.enemyHead)

    const spot1 = new Graphics()
    spot1.circle(-4, 0, 2.5)
    spot1.fill(COLORS.enemySpot)

    const spot2 = new Graphics()
    spot2.circle(4, 4, 2.5)
    spot2.fill(COLORS.enemySpot)

    container.addChild(body, shell, head, spot1, spot2)

    return container
  }

  private createBush(): Container {
    const container = new Container()

    const leafA = new Graphics()
    leafA.circle(-7, 2, 9)
    leafA.fill(COLORS.bushA)

    const leafB = new Graphics()
    leafB.circle(0, -3, 11)
    leafB.fill(COLORS.bushB)

    const leafC = new Graphics()
    leafC.circle(8, 3, 9)
    leafC.fill(COLORS.bushA)

    container.addChild(leafA, leafB, leafC)

    return container
  }

  private createSignboard(): Container {
    const container = new Container()

    const post = new Graphics()
    post.rect(-2, -2, 4, 18)
    post.fill(COLORS.signPost)

    const boardShadow = new Graphics()
    boardShadow.roundRect(-12.5, -14, 25, 14, 3)
    boardShadow.fill(COLORS.signShadow)

    const board = new Graphics()
    board.roundRect(-11.5, -15, 23, 12, 3)
    board.fill(COLORS.signBoard)

    const label = new Text({
      text: 'Building...',
      style: new TextStyle({
        fontSize: 6,
        fontFamily: 'Arial, sans-serif',
        fill: '#4f2500',
      }),
    })
    label.anchor.set(0.5)
    label.position.set(0, -9)

    container.addChild(post, boardShadow, board, label)

    return container
  }
}
