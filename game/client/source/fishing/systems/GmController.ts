import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { pickCommissionFish, pickFishForBite } from '../data/FishCatalog'
import { SailingState } from '../states/SailingState'
import { WaitingState } from '../states/WaitingState'
import { BattleState } from '../states/BattleState'

export type GmPhase = 'sailing' | 'lure' | 'battle'

/**
 * Dev-only shortcuts to jump into the three gameplay phases without
 * playing through the full loop (wave rhythm → cast → lure → chase).
 */
export class GmController {
  constructor(
    private readonly ctx: FishingContext,
    private readonly readStateId: () => FishingStateId | null,
  ) {}

  getStateId(): FishingStateId | null {
    return this.readStateId()
  }

  getRenderMode(): string {
    return this.ctx.gameState.getMode()
  }

  jumpTo(phase: GmPhase): void {
    this.ensureAudio()
    this.ctx.catchBanner.hide()
    this.ctx.eventOverlay.hide()
    this.ctx.castPreview.hide()

    switch (phase) {
      case 'sailing':
        this.jumpToSailing()
        break
      case 'lure':
        this.jumpToLure()
        break
      case 'battle':
        this.jumpToBattle()
        break
    }
  }

  private ensureAudio(): void {
    this.ctx.audio.unlock()
    this.ctx.audio.startGrooveBed()
  }

  private placeHookUnderwater(depth01 = 0.45): void {
    const { hook, boat, viewport } = this.ctx
    hook.rodTipX = boat.rodTipX
    hook.rodTipY = boat.rodTipY
    const y = viewport.waterLineY + viewport.maxDepth * depth01
    hook.x = boat.deckCenterX
    hook.y = y
    hook.vx = 0
    hook.vy = 0
    hook.container.visible = true
    hook.setMode('hover')
  }

  private jumpToSailing(): void {
    this.ctx.activeBiter = null
    this.ctx.gameState.resetToFishing()
    this.ctx.goTo(new SailingState(this.ctx))
  }

  private jumpToLure(): void {
    this.ctx.activeBiter = null
    this.ctx.gameState.resetToFishing()
    if (!this.ctx.commissionFish) {
      this.ctx.commissionFish = pickCommissionFish(
        this.ctx.hungerSystem.getHunger(),
        Math.random,
        this.ctx.progression.stage.zone,
      )
    }
    this.placeHookUnderwater(0.45)
    this.ctx.goTo(new WaitingState(this.ctx))
  }

  private jumpToBattle(): void {
    const { fishSchool, hook, viewport, weatherSystem, progression } = this.ctx
    const depth01 = 0.5
    this.placeHookUnderwater(depth01)
    const def = pickFishForBite(
      weatherSystem.get(),
      depth01,
      Math.random,
      progression.index * 0.15,
      progression.stage.zone,
    )
    const ambient = fishSchool.spawnNear(hook.x, hook.y, def)
    this.ctx.activeBiter = { def: ambient.def }
    this.ctx.gameState.enterChaseDirect()
    this.ctx.goTo(new BattleState(this.ctx), { ambient: ambient.fish })
  }
}
