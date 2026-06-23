import type { Application } from 'pixi.js'
import type { IFishingState } from './StateMachine'
import type { ViewportContext, FishDef } from './types'
import type { Boat } from './entities/Boat'
import type { Ocean } from './entities/Ocean'
import type { Penguin } from './entities/Penguin'
import type { Hook } from './entities/Hook'
import type { FishSchool } from './entities/FishSchool'
import type { MermaidRock } from './entities/MermaidRock'
import type { Whale } from './entities/Whale'
import type { Hud } from './ui/Hud'
import type { CastPreview } from './ui/CastPreview'
import type { ReelButtons } from './ui/ReelButtons'
import type { TensionBar } from './ui/TensionBar'
import type { WillpowerBar } from './ui/WillpowerBar'
import type { PullPanel } from './ui/PullPanel'
import type { EventOverlay } from './ui/EventOverlay'
import type { CatchBanner } from './ui/CatchBanner'
import type { NoteLane } from './ui/NoteLane'
import type { FrenzyOverlay } from './ui/FrenzyOverlay'
import type { HungerSystem } from './systems/HungerSystem'
import type { WeatherSystem } from './systems/WeatherSystem'
import type { AudioSystem } from './systems/AudioSystem'
import type { PointerTracker } from './systems/PointerTracker'
import type { BeatClock } from './systems/BeatClock'
import type { ProgressionSystem } from './systems/ProgressionSystem'
import type { FishingEventBus } from './events'

/**
 * Read/write surface that the per-state classes use to talk to the
 * scene. Keeping this as a structural interface (rather than passing
 * the entire `FishingScene`) makes it obvious which fields a state is
 * allowed to touch, and also avoids a circular import nightmare.
 */
export interface FishingContext {
  readonly app: Application
  readonly viewport: ViewportContext
  // Entities
  readonly boat: Boat
  readonly ocean: Ocean
  readonly penguin: Penguin
  readonly hook: Hook
  readonly fishSchool: FishSchool
  readonly mermaidRock: MermaidRock
  readonly whale: Whale
  // UI
  readonly hud: Hud
  readonly castPreview: CastPreview
  readonly reelButtons: ReelButtons
  readonly tensionBar: TensionBar
  readonly willpowerBar: WillpowerBar
  readonly pullPanel: PullPanel
  readonly eventOverlay: EventOverlay
  readonly catchBanner: CatchBanner
  readonly noteLane: NoteLane
  readonly frenzyOverlay: FrenzyOverlay
  // Systems
  readonly hungerSystem: HungerSystem
  readonly weatherSystem: WeatherSystem
  readonly audio: AudioSystem
  readonly pointer: PointerTracker
  readonly beatClock: BeatClock
  /**
   * Run difficulty ladder. The explicit, legible difficulty axis —
   * stage climbs with catches and sets the floor on every battle knob.
   */
  readonly progression: ProgressionSystem
  /**
   * Typed pub/sub bus for gameplay facts (e.g. `fishCaught`). Emit from
   * the place an event happens; subscribe in FishingScene setup so new
   * mechanics don't bloat the emitter.
   */
  readonly events: FishingEventBus
  // Session state
  /** Score for the current play session. */
  sessionScore: number
  /**
   * Number of fish successfully caught since the page loaded. Drives the
   * music's "escalation curve" — each new battle starts at a later
   * section in the song so veteran players hit the chorus sooner and
   * the arrangement gets more dense as the session progresses. Reset
   * only on page reload (the FishingContext is recreated then).
   */
  catchesThisRun: number
  /** The fish the penguin is currently asking for (null = no commission). */
  commissionFish: FishDef | null
  /** The fish currently being fought (null when idle). */
  activeBiter: { def: FishDef; sourceFishId?: number } | null

  /** Trigger a state transition. */
  goTo(state: IFishingState, payload?: unknown): void
  /** Update HUD with current metrics. */
  refreshHud(): void
  /** Add to score and refresh HUD. */
  addScore(amount: number): void
  /** Trigger a short screen shake (used for misses / struggle hits / line snap). */
  shake(amplitudePx: number, durationSeconds: number): void
}
