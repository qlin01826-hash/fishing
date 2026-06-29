/**
 * Outer render-mode state machine — orthogonal to FishingStateId gameplay states.
 *
 * FISHING_2D          → tranquil flat layers
 * HOOKED_TRANSITION   → bullet time + flash + camera fly-in
 * DEEP_SEA_CHASE_3D   → perspective chase frustum
 */
export enum GameRenderMode {
  FISHING_2D = 'fishing_2d',
  HOOKED_TRANSITION = 'hooked_transition',
  DEEP_SEA_CHASE_3D = 'deep_sea_chase_3d',
}

export interface GameStateControllerHooks {
  onModeChanged?(mode: GameRenderMode): void
  onTransitionComplete?(): void
}

const BULLET_TIME_SCALE = 0.22
const TRANSITION_DURATION_S = 0.55
const FLASH_DURATION_S = 0.2

export class GameStateController {
  private mode = GameRenderMode.FISHING_2D
  private transitionT = 0
  private flashT = 0
  private pendingBattleStart: (() => void) | null = null
  private readonly hooks: GameStateControllerHooks

  /** Global time dilation (1 = normal). */
  timeScale = 1

  constructor(hooks: GameStateControllerHooks = {}) {
    this.hooks = hooks
  }

  getMode(): GameRenderMode {
    return this.mode
  }

  isFishing2D(): boolean {
    return this.mode === GameRenderMode.FISHING_2D
  }

  isChase3D(): boolean {
    return this.mode === GameRenderMode.DEEP_SEA_CHASE_3D
  }

  isTransitioning(): boolean {
    return this.mode === GameRenderMode.HOOKED_TRANSITION
  }

  /** Transition progress 0..1 during HOOKED_TRANSITION. */
  getTransitionProgress(): number {
    return this.transitionT
  }

  getFlashAlpha(): number {
    if (this.flashT <= 0) return 0
    return Math.min(1, this.flashT / FLASH_DURATION_S) * (1 - this.transitionT * 0.5)
  }

  /**
   * Called when a fish bites. Starts bullet-time cinematic before chase.
   * `onBattleReady` fires once fly-in completes (caller should enter BattleState).
   */
  onFishHooked(onBattleReady: () => void): void {
    if (this.mode !== GameRenderMode.FISHING_2D) return
    this.mode = GameRenderMode.HOOKED_TRANSITION
    this.transitionT = 0
    this.flashT = FLASH_DURATION_S
    this.timeScale = BULLET_TIME_SCALE
    this.pendingBattleStart = onBattleReady
    this.hooks.onModeChanged?.(this.mode)
  }

  /** Force return to peaceful 2D (e.g. after catch / flee). */
  resetToFishing(): void {
    this.mode = GameRenderMode.FISHING_2D
    this.transitionT = 0
    this.flashT = 0
    this.timeScale = 1
    this.pendingBattleStart = null
    this.hooks.onModeChanged?.(this.mode)
  }

  enterChaseDirect(): void {
    this.mode = GameRenderMode.DEEP_SEA_CHASE_3D
    this.transitionT = 1
    this.flashT = 0
    this.timeScale = 1
    this.hooks.onModeChanged?.(this.mode)
  }

  update(dtSeconds: number): void {
    if (this.mode !== GameRenderMode.HOOKED_TRANSITION) return

    const dilated = dtSeconds * this.timeScale
    this.transitionT = Math.min(1, this.transitionT + dilated / TRANSITION_DURATION_S)
    this.flashT = Math.max(0, this.flashT - dtSeconds)

    if (this.transitionT < 0.35) {
      this.timeScale = BULLET_TIME_SCALE
    } else {
      const u = (this.transitionT - 0.35) / 0.65
      this.timeScale = BULLET_TIME_SCALE + (1 - BULLET_TIME_SCALE) * u
    }

    if (this.transitionT >= 1) {
      this.mode = GameRenderMode.DEEP_SEA_CHASE_3D
      this.timeScale = 1
      this.flashT = 0
      this.hooks.onModeChanged?.(this.mode)
      const cb = this.pendingBattleStart
      this.pendingBattleStart = null
      cb?.()
      this.hooks.onTransitionComplete?.()
    }
  }
}
