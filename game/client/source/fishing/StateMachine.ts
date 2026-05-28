import type { FishingStateId } from './types'

/**
 * Minimal scene-local state machine. Each `IFishingState` owns the
 * lifetime of any sprites/UI it creates and is told when to step.
 *
 * Why this exists: the fishing loop has 7 distinct phases that look
 * very different visually and use disjoint input handlers. Keeping them
 * in separate classes makes it obvious what's allowed in each phase
 * without giant switch statements in `FishingScene.update`.
 */
export interface IFishingState {
  readonly id: FishingStateId
  enter(payload?: unknown): void
  update(dtSeconds: number, elapsedMs: number): void
  /** Pointer events forwarded by the scene. Optional per-state. */
  onPointerDown?(x: number, y: number, pointerId: number): void
  onPointerMove?(x: number, y: number, pointerId: number): void
  onPointerUp?(x: number, y: number, pointerId: number): void
  exit(): void
}

export class StateMachine {
  private current: IFishingState | null = null

  get currentId(): FishingStateId | null {
    return this.current?.id ?? null
  }

  /** Replace the active state, invoking exit() and enter() in order. */
  transitionTo(next: IFishingState, payload?: unknown): void {
    if (this.current) this.current.exit()
    this.current = next
    next.enter(payload)
  }

  update(dtSeconds: number, elapsedMs: number): void {
    this.current?.update(dtSeconds, elapsedMs)
  }

  pointerDown(x: number, y: number, pointerId: number): void {
    this.current?.onPointerDown?.(x, y, pointerId)
  }

  pointerMove(x: number, y: number, pointerId: number): void {
    this.current?.onPointerMove?.(x, y, pointerId)
  }

  pointerUp(x: number, y: number, pointerId: number): void {
    this.current?.onPointerUp?.(x, y, pointerId)
  }

  destroy(): void {
    this.current?.exit()
    this.current = null
  }
}
