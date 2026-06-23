import type { EventBus } from '../engine/EventBus'
import type { FishDef } from './types'

/**
 * Gameplay "facts" that have happened in the fishing game. Emitters fire
 * these without knowing who reacts; systems subscribe in the scene's
 * setup (the composition root).
 *
 * Add a new key here when a new mechanic needs to broadcast something —
 * then subscribe to it in `FishingScene` rather than reaching into the
 * state that produced it.
 */
export interface FishingEvents {
  /**
   * A fish was successfully landed. Fired once by `CatchState`. Systems
   * that care (difficulty ladder, music richness, future achievements /
   * combos / stats) subscribe instead of being called by hand.
   */
  fishCaught: {
    def: FishDef
    /** Score awarded for this catch (already weather-adjusted). */
    score: number
    /** True when this catch matched the penguin's commission request. */
    commissionFulfilled: boolean
  }
}

/** A typed event bus bound to this game's event map. */
export type FishingEventBus = EventBus<FishingEvents>
