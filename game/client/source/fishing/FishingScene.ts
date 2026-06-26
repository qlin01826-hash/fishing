import { Container } from 'pixi.js'
import type { GameScene } from '../engine/Engine'
import { Engine } from '../engine/Engine'
import { EventBus } from '../engine/EventBus'
import type { FishingContext } from './FishingContext'
import type { FishingEvents } from './events'
import { bedFloorForStage } from './systems/AudioSystem'
import { StateMachine, type IFishingState } from './StateMachine'
import type { FishDef, ViewportContext } from './types'

import { Boat } from './entities/Boat'
import { Ocean } from './entities/Ocean'
import { Penguin } from './entities/Penguin'
import { Hook } from './entities/Hook'
import { FishSchool } from './entities/FishSchool'
import { MermaidRock } from './entities/MermaidRock'
import { Whale } from './entities/Whale'
import { SkyLayer } from './entities/SkyLayer'
import { HorizonLayer } from './entities/HorizonLayer'
import { ForegroundProps } from './entities/ForegroundProps'
import { FogLayer } from './entities/FogLayer'
import { AbyssOverlay } from './entities/AbyssOverlay'
import { SeafloorLayer } from './entities/SeafloorLayer'

import { Hud } from './ui/Hud'
import { CastPreview } from './ui/CastPreview'
import { ReelButtons } from './ui/ReelButtons'
import { TensionBar } from './ui/TensionBar'
import { WillpowerBar } from './ui/WillpowerBar'
import { PullPanel } from './ui/PullPanel'
import { LurePads } from './ui/LurePads'
import { EventOverlay } from './ui/EventOverlay'
import { CatchBanner } from './ui/CatchBanner'
import { NoteLane } from './ui/NoteLane'
import { FrenzyOverlay } from './ui/FrenzyOverlay'

import { HungerSystem } from './systems/HungerSystem'
import { WeatherSystem } from './systems/WeatherSystem'
import { TimeOfDaySystem } from './systems/TimeOfDaySystem'
import { ProgressionSystem } from './systems/ProgressionSystem'
import { AudioSystem } from './systems/AudioSystem'
import { PointerTracker } from './systems/PointerTracker'
import { BeatClock } from './systems/BeatClock'

import { SailingState } from './states/SailingState'

/**
 * Scene root: owns all Pixi containers, all entities/UI/systems, runs
 * the per-frame update, and forwards canvas pointer events to the
 * active state via `StateMachine`.
 *
 * Layered render order (back → front):
 *
 *     ocean
 *     │   underwater entities (fish school)
 *     │   waterline overlays (waves)
 *     │   above-water entities (boat, penguin, hook line+bobber)
 *     │
 *     ui (hud, panels, overlays, banners)
 *
 * `viewportContext` is recomputed in `onResize` and is the single
 * source of truth for "where is the waterline / how deep can we go".
 */
export class FishingScene implements GameScene {
  private readonly engine: Engine

  private readonly rootContainer = new Container()
  private readonly skyContainer = new Container()
  private readonly underWaterContainer = new Container()
  private readonly aboveWaterContainer = new Container()
  private readonly uiContainer = new Container()
  private readonly topUiContainer = new Container()

  private readonly stateMachine = new StateMachine()
  private viewport: ViewportContext = { width: 1, height: 1, waterLineY: 1, maxDepth: 1 }

  // Entities
  private readonly ocean: Ocean
  private readonly boat: Boat
  private readonly penguin: Penguin
  private readonly hook: Hook
  private readonly fishSchool: FishSchool
  private readonly mermaidRock: MermaidRock
  private readonly whale: Whale
  private readonly skyLayer: SkyLayer
  private readonly horizonLayer: HorizonLayer
  private readonly foregroundProps: ForegroundProps
  private readonly fogLayer: FogLayer
  private readonly abyssOverlay: AbyssOverlay
  private readonly seafloorLayer: SeafloorLayer

  // UI
  private readonly hud: Hud
  private readonly castPreview: CastPreview
  private readonly reelButtons: ReelButtons
  private readonly tensionBar: TensionBar
  private readonly willpowerBar: WillpowerBar
  private readonly pullPanel: PullPanel
  private readonly lurePads: LurePads
  private readonly eventOverlay: EventOverlay
  private readonly catchBanner: CatchBanner
  private readonly noteLane: NoteLane
  private readonly frenzyOverlay: FrenzyOverlay

  // Systems
  private readonly hungerSystem = new HungerSystem()
  private readonly weatherSystem = new WeatherSystem()
  private readonly timeOfDay = new TimeOfDaySystem()
  private readonly progression = new ProgressionSystem()
  /** Eased abyss-mood value (0..1) following the stage's depthMood. */
  private depthMoodCurrent = 0
  private readonly audio = new AudioSystem()
  private readonly pointer = new PointerTracker()
  private readonly beatClock = new BeatClock()
  private readonly events = new EventBus<FishingEvents>()

  // Session state
  private sessionScore = 0
  private catchesThisRun = 0
  private commissionFish: FishDef | null = null
  private activeBiter: FishingContext['activeBiter'] = null

  // Camera scrolling for underwater rhythm game
  cameraY = 0
  cameraYTarget = 0

  private elapsedMs = 0

  // Screen shake state. `shakeTime` decays from `shakeDuration` to 0;
  // `shakeAmplitude` is the peak pixel offset at t = shakeDuration.
  private shakeTime = 0
  private shakeDuration = 0
  private shakeAmplitude = 0

  // Bound DOM listeners (for cleanup)
  private readonly onCanvasPointerDown: (e: PointerEvent) => void
  private readonly onCanvasPointerMove: (e: PointerEvent) => void
  private readonly onCanvasPointerUp: (e: PointerEvent) => void
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void

  constructor(engine: Engine) {
    this.engine = engine

    this.ocean = new Ocean(this.viewport)
    this.boat = new Boat()
    this.penguin = new Penguin()
    this.hook = new Hook()
    this.fishSchool = new FishSchool(this.viewport)
    this.mermaidRock = new MermaidRock()
    this.whale = new Whale()
    this.skyLayer = new SkyLayer(this.viewport)
    this.horizonLayer = new HorizonLayer(this.viewport)
    this.foregroundProps = new ForegroundProps(this.viewport)
    this.fogLayer = new FogLayer(this.viewport)
    this.abyssOverlay = new AbyssOverlay(this.viewport)
    this.seafloorLayer = new SeafloorLayer(this.viewport)

    this.hud = new Hud()
    this.castPreview = new CastPreview(this.viewport)
    this.reelButtons = new ReelButtons()
    this.tensionBar = new TensionBar()
    this.willpowerBar = new WillpowerBar()
    this.pullPanel = new PullPanel()
    this.lurePads = new LurePads()
    this.eventOverlay = new EventOverlay()
    this.catchBanner = new CatchBanner()
    this.noteLane = new NoteLane()
    this.frenzyOverlay = new FrenzyOverlay()

    // Wire the BeatClock into the rhythm-dependent layers. The clock
    // itself stays dormant (returning sentinel values) until the audio
    // context is unlocked inside the first user gesture; that unlock
    // also calls beatClock.start() to anchor both time domains.
    this.audio.attachBeatClock(this.beatClock)
    this.pullPanel.attachBeatClock(this.beatClock)
    this.noteLane.attachBeatClock(this.beatClock)
    this.lurePads.attachBeatClock(this.beatClock)

    // Cross-system reactions to "a fish was caught" live here (the
    // composition root), not inside CatchState. Adding a new reaction
    // (achievement, combo, stat…) means subscribing here — CatchState
    // just emits the fact and never grows.
    this.events.on('fishCaught', () => {
      // Advance the difficulty ladder one stage (every catch = one stage).
      this.progression.reportCatch()
      // Ratchet the continuous music bed UP a notch so the arrangement
      // gains layers and never thins back out as the run deepens.
      this.audio.setSectionFloor(bedFloorForStage(this.progression.index))
    })

    // Render order — ocean & sky underneath, then underwater, then above
    this.rootContainer.addChild(this.skyContainer)
    this.rootContainer.addChild(this.underWaterContainer)
    this.rootContainer.addChild(this.aboveWaterContainer)
    this.rootContainer.addChild(this.uiContainer)
    this.rootContainer.addChild(this.topUiContainer)

    // SKY backdrop, painted back-to-front so distance reads correctly:
    //   1. ocean.backLayer    – sky gradient + underwater gradient
    //   2. horizonLayer       – distant mountains + passing islands
    //   3. skyLayer           – sun, drifting clouds, seagull flocks
    //   4. ocean.frontLayer   – wave ribbons, rain, lightning flash
    // Putting horizon + clouds BETWEEN ocean's back and front layers
    // means crests of nearby waves visibly cover the base of the
    // distant mountain silhouette — the way a real horizon does.
    this.skyContainer.addChild(this.ocean.backLayer)
    this.skyContainer.addChild(this.horizonLayer.container)
    this.skyContainer.addChild(this.skyLayer.container)
    this.skyContainer.addChild(this.ocean.frontLayer)

    // Whale sits BEHIND the fish school so the fish always visibly
    // swim in front of the much bigger silhouette.
    this.underWaterContainer.addChild(this.seafloorLayer.container)
    this.underWaterContainer.addChild(this.whale.container)
    this.underWaterContainer.addChild(this.fishSchool.container)
    this.underWaterContainer.addChild(this.hook.container)
    // Surface splashes live in the ABOVE-water layer (in front of the
    // waves/foam) but BEFORE the mermaid/boat so the boat hull always
    // sits on top of any splash trail.
    this.aboveWaterContainer.addChild(this.fishSchool.splashContainer)
    // Whale spout — also above water, alongside splash particles, so
    // the column visibly punches above the wave line.
    this.aboveWaterContainer.addChild(this.whale.spoutContainer)
    // Foreground props (passing reefs, buoys, driftwood) — closer to
    // camera than the horizon islands, so they sit ABOVE the wave
    // ribbons but BEHIND the boat / mermaid so a buoy never visually
    // jumps in front of the hull as it drifts past.
    this.aboveWaterContainer.addChild(this.foregroundProps.container)
    // Mermaid sits in front of the ocean but behind the boat/penguin so
    // the boat visibly passes IN FRONT of her rock during enhanced beats.
    this.aboveWaterContainer.addChild(this.mermaidRock.container)
    // Boat foam wake — drawn BEFORE the boat so the hull occludes the
    // leading edge of the trail. World-space, not parented to the boat.
    this.aboveWaterContainer.addChild(this.boat.wakeContainer)
    this.aboveWaterContainer.addChild(this.boat.container)
    this.aboveWaterContainer.addChild(this.penguin.container)
    // Sea fog sits ON TOP of everything in the above-water layer so it
    // visibly muffles the boat/mermaid silhouettes during a heavy
    // storm or a deep-night run.
    this.aboveWaterContainer.addChild(this.fogLayer.container)
    // Abyss pressure vignette — the very topmost above-water layer so it
    // dims the whole seascape (boat, fish, fog) as the run descends,
    // while the UI/topUi containers above stay perfectly crisp.
    this.aboveWaterContainer.addChild(this.abyssOverlay.container)

    this.uiContainer.addChild(this.castPreview.container)
    this.uiContainer.addChild(this.reelButtons.container)
    this.uiContainer.addChild(this.pullPanel.container)
    this.uiContainer.addChild(this.lurePads.container)
    // Note lane sits ON TOP of the pull panel so the notes stay visible
    // as they slide across the panel disc; the panel itself already
    // pulses on each beat, so the lane skips its own hit-zone marker.
    this.uiContainer.addChild(this.noteLane.container)
    this.uiContainer.addChild(this.willpowerBar.container)

    this.topUiContainer.addChild(this.tensionBar.container)
    this.topUiContainer.addChild(this.eventOverlay.container)
    this.topUiContainer.addChild(this.hud.container)
    // FrenzyOverlay sits BETWEEN the normal HUD and the catch banner so
    // its vignette/banner are visible on top of the playfield but the
    // post-catch result banner still slides in over the top.
    this.topUiContainer.addChild(this.frenzyOverlay.container)
    this.topUiContainer.addChild(this.catchBanner.container)

    this.engine.app.stage.addChild(this.rootContainer)

    // DOM listeners — we use direct canvas events (not @minigame/platform)
    // because the cast charge mechanic needs *raw* velocity sampling with
    // pointer capture; the platform abstractions assume joystick-style
    // continuous values which would smooth that signal away.
    this.onCanvasPointerDown = (e) => this.handlePointerDown(e)
    this.onCanvasPointerMove = (e) => this.handlePointerMove(e)
    this.onCanvasPointerUp = (e) => this.handlePointerUp(e)
    this.onKeyDown = (e) => this.handleKeyDown(e)
    this.onKeyUp = (e) => this.handleKeyUp(e)
  }

  init(): void {
    const canvas = this.engine.app.canvas
    canvas.addEventListener('pointerdown', this.onCanvasPointerDown)
    canvas.addEventListener('pointermove', this.onCanvasPointerMove)
    canvas.addEventListener('pointerup', this.onCanvasPointerUp)
    canvas.addEventListener('pointercancel', this.onCanvasPointerUp)
    canvas.style.touchAction = 'none'
    // Keyboard: SPACE is the PC equivalent of the bottom-rhythm-panel tap.
    // We listen at the window level so the canvas doesn't need focus.
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    // Hide bars that are only used during battle
    this.tensionBar.container.visible = false
    this.willpowerBar.container.visible = false
    this.pullPanel.container.visible = false
    this.lurePads.container.visible = false
    this.noteLane.container.visible = false

    // Boot the hunger system with offline catch-up so re-opening a tab
    // after a long break greets the player with a starving penguin.
    this.hungerSystem.applyOfflineGrowth()
    this.weatherSystem.update(
      this.hungerSystem.getHunger(),
      this.progression.voyage,
      this.progression.stage.zone,
    )

    this.onResize(this.engine.app.renderer.width, this.engine.app.renderer.height)
    this.refreshHud()
    // Pre-position the penguin on the boat deck so its commission
    // bubble doesn't flash at (0,0) for a single frame on first paint.
    // The real per-frame sync happens inside update().
    this.boat.update(0, this.weatherSystem.get(), this.elapsedMs, this.viewport)
    this.penguin.setPosition(this.boat.deckCenterX, this.boat.deckTopY - 44)

    // Start in sailing — SailingState will roll a commission.
    const ctx = this.buildContext()
    this.stateMachine.transitionTo(new SailingState(ctx))
  }

  update(deltaSeconds: number): void {
    this.elapsedMs += deltaSeconds * 1000

    // Systems
    this.hungerSystem.update(deltaSeconds, this.elapsedMs)
    this.weatherSystem.update(
      this.hungerSystem.getHunger(),
      this.progression.voyage,
      this.progression.stage.zone,
    )
    this.timeOfDay.update(deltaSeconds)
    const weather = this.weatherSystem.get()
    const tod = this.timeOfDay.get()
    this.audio.setWeather(weather.intensity)
    // Push the time-of-day snapshot into every layer that paints itself
    // differently between day and night. We use setters (not constructor
    // wiring) so the data flow is obvious — one place "broadcasts", and
    // each entity caches the latest value for its own draw step.
    this.skyLayer.setTimeOfDay(tod)
    this.horizonLayer.setTimeOfDay(tod)
    this.foregroundProps.setTimeOfDay(tod)
    this.fogLayer.setTimeOfDay(tod)
    this.fogLayer.setWeather(weather)
    // Mermaid's moonlight glow ramps up as nightPhase climbs past
    // ~0.55 (the "evening" threshold) and peaks at midnight.
    this.mermaidRock.setMoonlight(Math.max(0, (tod.nightPhase - 0.55) / 0.45))
    // The boat needs its own night strength so the lantern fades in/out.
    this.boat.setNightStrength(tod.nightPhase)

    // Beat pulse: 1.0 right on a beat, fading toward 0 by ~25% into the
    // beat. Even outside of battle (when drums are silent) the clock is
    // ticking after the first user gesture, so the whole scene gently
    // bobs to the implicit tempo of the soundtrack.
    const beatPhase = this.beatClock.started ? this.beatClock.phase() : 0.5
    const beatPulse = beatPhase < 0.25 ? 1 - beatPhase / 0.25 : 0

    const stateId = this.stateMachine.currentId
    const underway =
      stateId === 'sailing' || stateId === 'sinking' || stateId === 'waiting'
    this.progression.updateVoyage(deltaSeconds, underway, this.viewport.width)
    const scrollPx = this.progression.scroll
    const voyageVisual = this.progression.voyage
    const sailMul = underway ? 1.15 + voyageVisual * 0.85 : 0.35

    // Abyss descent mood: blend stage milestone with live voyage position
    // so the water darkens gradually while the boat sails between catches.
    const targetMood = Math.max(this.progression.depthMood, this.progression.getVoyageDepthMood())
    this.depthMoodCurrent += (targetMood - this.depthMoodCurrent) * Math.min(1, deltaSeconds * 1.2)
    this.ocean.setDepthMood(this.depthMoodCurrent)
    this.ocean.setWorldScroll(scrollPx)
    this.abyssOverlay.setMood(this.depthMoodCurrent)
    this.horizonLayer.setDepthMood(this.depthMoodCurrent)
    this.horizonLayer.setWorldScroll(scrollPx)
    this.fishSchool.setDepthMood(this.depthMoodCurrent)
    this.fishSchool.setWorldScroll(scrollPx)
    this.fishSchool.setStageZone(this.progression.stage.zone)
    this.seafloorLayer.setDepthMood(this.depthMoodCurrent)
    this.seafloorLayer.setWorldScroll(scrollPx)
    this.foregroundProps.setWorldScroll(scrollPx)

    // Leave the beach: hull drifts from near-shore (left) toward mid-lane.
    const depart = Math.min(1, scrollPx / Math.max(1, this.viewport.width * 0.65))
    const boatX = this.viewport.width * (0.32 + depart * 0.18)
    this.boat.setAnchorX(boatX)
    this.seafloorLayer.setTimeOfDay(tod)
    this.seafloorLayer.update(deltaSeconds)
    this.abyssOverlay.update()

    // Entities
    this.ocean.update(deltaSeconds, weather, this.elapsedMs, beatPulse, tod, sailMul)
    // Distant sky decorations tick on the same weather snapshot so
    // clouds/birds dim during storms and the horizon mountains drift
    // with the wind. Updated BEFORE the foreground entities so any
    // composite reads (e.g. the sun position for moonlight later on)
    // see the freshest values. Aurora + shooting stars need the beat
    // pulse so they shimmer on the downbeat.
    this.skyLayer.update(deltaSeconds, weather, this.elapsedMs, beatPulse)
    this.horizonLayer.update(deltaSeconds, weather, sailMul)
    // Foreground reefs/buoys/driftwood scroll past at a faster
    // parallax than the horizon, with beat-synced foam pulses so
    // the "wakes" on each prop punch on the downbeat.
    this.foregroundProps.setBeatPulse(beatPulse)
    this.foregroundProps.update(deltaSeconds, weather, sailMul)
    // Fog reads its inputs via setters above; this tick advances drift.
    this.fogLayer.setBeatPulse(beatPulse)
    this.fogLayer.update(deltaSeconds)
    const waveAtHull = this.ocean.sampleHullWaveY(
      this.boat.getHullX(),
      weather,
      this.elapsedMs,
    )
    this.boat.setWaveContext(waveAtHull, this.viewport.waterLineY)
    this.boat.setSailing(underway)
    this.boat.update(deltaSeconds, weather, this.elapsedMs, this.viewport, beatPulse)
    this.penguin.setWaveSubmerge(this.boat.getWaveSubmerge())
    this.penguin.update(deltaSeconds, this.hungerSystem.getHunger(), beatPulse)
    // Pump the BeatClock phase into the school every frame so the
    // dance / splash logic stays in sync with the audio even after
    // BattleState (which also calls setBeatPhase) has exited.
    this.fishSchool.setBeatPhase(beatPhase)
    this.fishSchool.update(deltaSeconds, weather.intensity)
    this.hook.update(deltaSeconds, this.viewport, this.boat.rodTipX, this.boat.rodTipY, weather.windPush)
    this.mermaidRock.update(deltaSeconds)
    // Whale needs the beat phase so its spout fires on the downbeat
    // (same edge-detection trick the fish-school splash uses).
    this.whale.update(deltaSeconds, beatPhase)

    // Park the penguin on the boat's deck — skipped during overboard
    // failure or swim cameos where the penguin owns its own position.
    if (this.penguin.isAnchoredToBoat()) {
      this.penguin.setPosition(this.boat.deckCenterX, this.boat.deckTopY - 44)
    }

    // UI
    this.reelButtons.update(deltaSeconds)
    this.lurePads.update(deltaSeconds, performance.now())
    this.eventOverlay.update(deltaSeconds)
    this.catchBanner.update(deltaSeconds)
    this.noteLane.update(deltaSeconds, performance.now())
    // FrenzyOverlay ticks centrally so it can finish its exit animation
    // even after BattleState has already torn down. BattleState only
    // activates/deactivates it; this loop owns its visual lifecycle.
    {
      const phase = this.beatClock.started ? this.beatClock.phase(performance.now()) : 0.5
      const beatPulse = phase < 0.2 ? 1 - phase / 0.2 : 0
      this.frenzyOverlay.update(deltaSeconds, beatPulse)
    }
    this.refreshHud()

    // Lerp camera Y scroll for the underwater rhythm dive. Only the
    // SURFACE layers (sky + ocean + boat) slide up and away; the
    // underwater container stays in absolute screen space so the 3D
    // rhythm track mounted there lines up with the camera-compensated
    // penguin (which adds cameraY back in UnderwaterRhythmState).
    this.cameraY += (this.cameraYTarget - this.cameraY) * Math.min(1, deltaSeconds * 4.0)
    this.skyContainer.position.y = -this.cameraY
    this.aboveWaterContainer.position.y = -this.cameraY

    this.stateMachine.update(deltaSeconds, this.elapsedMs)

    this.tickShake(deltaSeconds)
  }

  /** Trigger a brief screen-shake. Replaces any in-flight shake. */
  triggerShake(amplitudePx: number, durationSeconds: number): void {
    this.shakeAmplitude = amplitudePx
    this.shakeDuration = durationSeconds
    this.shakeTime = durationSeconds
  }

  private tickShake(dtSeconds: number): void {
    if (this.shakeTime <= 0) {
      if (this.rootContainer.position.x !== 0 || this.rootContainer.position.y !== 0) {
        this.rootContainer.position.set(0, 0)
      }
      return
    }
    this.shakeTime = Math.max(0, this.shakeTime - dtSeconds)
    // Damped sinusoidal shake — amplitude ramps down with remaining time.
    const t01 = this.shakeTime / Math.max(0.001, this.shakeDuration)
    const decay = t01 * t01 // quadratic falloff for a snappier feel
    const offset = this.shakeAmplitude * decay
    this.rootContainer.position.set(
      (Math.random() - 0.5) * 2 * offset,
      (Math.random() - 0.5) * 2 * offset,
    )
  }

  onResize(width: number, height: number): void {
    const waterLineY = Math.round(height * 0.42)
    // Reserve room at the bottom for the on-screen controls — but scale
    // it with height instead of a fixed 160px. On short LANDSCAPE PHONE
    // viewports (height ~430) a fixed 160 ate ~37% of the screen, which
    // crushed the underwater column so every fish bunched up just below
    // the surface (and looked like it was floating ON the water). A
    // height-proportional reserve keeps a usable water column on phones
    // while staying generous on tall desktop windows.
    const bottomReserve = Math.round(Math.max(64, Math.min(150, height * 0.18)))
    const maxDepth = Math.max(150, height - waterLineY - bottomReserve)
    this.viewport = { width, height, waterLineY, maxDepth }
    this.ocean.setViewport(this.viewport)
    this.castPreview.setViewport(this.viewport)
    this.fishSchool.setViewport(this.viewport)
    this.whale.setViewport(this.viewport)
    this.skyLayer.setViewport(this.viewport)
    this.horizonLayer.setViewport(this.viewport)
    this.foregroundProps.setViewport(this.viewport)
    this.fogLayer.setViewport(this.viewport)
    this.abyssOverlay.setViewport(this.viewport)
    this.seafloorLayer.setViewport(this.viewport)
    this.boat.setBase(width * 0.32, waterLineY - 8)
    this.mermaidRock.setLayout(width, waterLineY)
    this.hud.setLayout(width, height)

    // Layout constants — derived once so every UI element agrees on
    // where the HUD ends, where the tension bar lives, etc. Without
    // this they were each picking absolute Y values that happened to
    // overlap on landscape phones (HUD hunger row at 36 vs tension bar
    // also at 36, etc.).
    const hudBottomY = 56 // HUD score row (10..28) + hunger row (36..48) + breathing room
    const tensionTopY = hudBottomY + 8 // bar starts here
    const tensionHeight = 18
    const tensionBottomY = tensionTopY + tensionHeight + 14 // includes the small label below
    // Event overlay's big "FOLLOW FISH!" text sits BELOW the tension bar
    // and ABOVE the playfield so it doesn't fight either layer.
    this.eventOverlay.setLayout(width / 2, height / 2, tensionBottomY + 18)

    // Reel buttons docked above-bottom-right
    this.reelButtons.setPosition(width - 16 - 120, height - 16 - 56 - 8 - 38)
    // Pull panel: circular tap zone anchored bottom-left. Scale the
    // radius to the smaller screen dimension so it stays usable on
    // narrow mobile viewports without dominating wide ones.
    const minDim = Math.min(width, height)
    const pullRadius = Math.max(56, Math.min(110, minDim * 0.14))
    const pullCx = pullRadius + 20
    const pullCy = height - pullRadius - 20
    this.pullPanel.setPosition(pullCx, pullCy, pullRadius)
    this.lurePads.setLayout(width, height)
    // Note lane: anchored to the pull-panel centre and extending right.
    // Length scales with viewport so wider screens get more look-ahead
    // visible at once. Reserve room for the willpower bar on the right.
    const willpowerBarWidth = 32 // visual width of the willpower bar + its label
    const laneLength = Math.max(200, Math.min(560, width - pullCx - willpowerBarWidth - 60))
    this.noteLane.setLayout(pullCx, pullCy, laneLength)
    // Tension bar position scales: full-width on wide screens, shrinks
    // on narrow ones so it doesn't crowd the corners.
    const tensionWidth = Math.min(420, width - 60)
    this.tensionBar.setLayout(width / 2, tensionTopY, tensionWidth)
    // Willpower bar: vertical strip on the right. We shorten it on
    // short viewports so it doesn't sit on top of the HUD/score row.
    const willpowerLen = Math.max(140, Math.min(320, height - tensionBottomY - pullRadius * 2 - 40))
    const willpowerCy = (tensionBottomY + (height - pullRadius * 2 - 20)) / 2
    this.willpowerBar.setLayout(width - 14, willpowerCy, willpowerLen)
    // Frenzy overlay tracks the full viewport — its vignette wraps
    // every edge and the banner anchors near the top.
    this.frenzyOverlay.setLayout(width, height)
  }

  destroy(): void {
    const canvas = this.engine.app.canvas
    canvas.removeEventListener('pointerdown', this.onCanvasPointerDown)
    canvas.removeEventListener('pointermove', this.onCanvasPointerMove)
    canvas.removeEventListener('pointerup', this.onCanvasPointerUp)
    canvas.removeEventListener('pointercancel', this.onCanvasPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.stateMachine.destroy()
    this.audio.destroy()
    this.events.clear()
    this.rootContainer.removeFromParent()
    this.rootContainer.destroy({ children: true })
  }

  // ---- input ----

  private toCanvas(e: PointerEvent): { x: number; y: number } {
    const rect = this.engine.app.canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  private handlePointerDown(e: PointerEvent): void {
    // Audio unlock: must happen inside a user gesture
    this.audio.unlock()
    // Kick off the always-on groove bed so the player hears continuous
    // music from the very first tap (not just during fights). Idempotent.
    this.audio.startGrooveBed()
    this.engine.app.canvas.setPointerCapture?.(e.pointerId)
    const { x, y } = this.toCanvas(e)
    this.stateMachine.pointerDown(x, y, e.pointerId)
  }

  private handlePointerMove(e: PointerEvent): void {
    const { x, y } = this.toCanvas(e)
    this.stateMachine.pointerMove(x, y, e.pointerId)
  }

  private handlePointerUp(e: PointerEvent): void {
    const { x, y } = this.toCanvas(e)
    this.stateMachine.pointerUp(x, y, e.pointerId)
  }

  private isSpaceKey(e: KeyboardEvent): boolean {
    // Match the modern `e.code` first, then fall back to `e.key` for
    // older browsers / Safari quirks.
    return e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
  }

  /**
   * SPACE triggers the rhythm panel only while it's actually on screen
   * (battle phase). We always preventDefault for Space anywhere in the
   * scene so the browser's "scroll page" reflex doesn't fire underneath
   * our game.
   */
  private handleKeyDown(e: KeyboardEvent): void {
    if (this.lurePads.container.visible) {
      const lureKey =
        e.code === 'KeyA' ||
        e.code === 'KeyD' ||
        e.code === 'KeyW' ||
        e.code === 'KeyS' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      if (lureKey) {
        e.preventDefault()
        this.audio.unlock()
        this.lurePads.keyboardEvent(true, e.code)
        return
      }
    }

    if (!this.isSpaceKey(e)) return
    e.preventDefault()
    if (e.repeat) {
      // Suppress key-repeat: holding Space should behave like "press
      // and hold the panel" (steady press), not "fire a fresh tap
      // every 30ms".
      return
    }
    if (!this.pullPanel.container.visible) return
    // Audio unlock requires a user gesture; keydown counts.
    this.audio.unlock()
    this.pullPanel.keyboardTap()
  }

  private handleKeyUp(e: KeyboardEvent): void {
    if (this.lurePads.container.visible) {
      const lureKey =
        e.code === 'KeyA' ||
        e.code === 'KeyD' ||
        e.code === 'KeyW' ||
        e.code === 'KeyS' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      if (lureKey) {
        e.preventDefault()
        this.lurePads.keyboardEvent(false, e.code)
        return
      }
    }

    if (!this.isSpaceKey(e)) return
    e.preventDefault()
    // Always release — if battle ended while Space was held, the panel
    // is now hidden but its `pressing` flag would otherwise stay stuck
    // until the next reset(). Calling release here is a no-op when the
    // panel isn't currently being held, so it's safe regardless.
    this.pullPanel.keyboardRelease()
  }

  // ---- context wiring ----

  /**
   * Build the structural context the states use to read/write scene
   * state. The states are free to MUTATE `sessionScore` / `commissionFish`
   * / `activeBiter` through this context object; we shadow getters/setters
   * onto the live scene fields so state mutations are visible everywhere.
   */
  private buildContext(): FishingContext {
    const scene = this
    return {
      app: this.engine.app,
      get viewport() {
        return scene.viewport
      },
      underWaterContainer: this.underWaterContainer,
      boat: this.boat,
      ocean: this.ocean,
      penguin: this.penguin,
      hook: this.hook,
      fishSchool: this.fishSchool,
      mermaidRock: this.mermaidRock,
      whale: this.whale,
      hud: this.hud,
      castPreview: this.castPreview,
      reelButtons: this.reelButtons,
      tensionBar: this.tensionBar,
      willpowerBar: this.willpowerBar,
      pullPanel: this.pullPanel,
      lurePads: this.lurePads,
      eventOverlay: this.eventOverlay,
      catchBanner: this.catchBanner,
      noteLane: this.noteLane,
      frenzyOverlay: this.frenzyOverlay,
      shake: (amplitude: number, duration: number) => scene.triggerShake(amplitude, duration),
      hungerSystem: this.hungerSystem,
      weatherSystem: this.weatherSystem,
      audio: this.audio,
      pointer: this.pointer,
      beatClock: this.beatClock,
      progression: this.progression,
      events: this.events,
      get sessionScore() {
        return scene.sessionScore
      },
      set sessionScore(value: number) {
        scene.sessionScore = value
      },
      get catchesThisRun() {
        return scene.catchesThisRun
      },
      set catchesThisRun(value: number) {
        scene.catchesThisRun = value
      },
      get commissionFish() {
        return scene.commissionFish
      },
      set commissionFish(value: FishDef | null) {
        scene.commissionFish = value
      },
      get activeBiter() {
        return scene.activeBiter
      },
      set activeBiter(value: FishingContext['activeBiter']) {
        scene.activeBiter = value
      },
      get cameraY() {
        return scene.cameraY
      },
      set cameraY(value: number) {
        scene.cameraY = value
      },
      get cameraYTarget() {
        return scene.cameraYTarget
      },
      set cameraYTarget(value: number) {
        scene.cameraYTarget = value
      },
      goTo: (next: IFishingState, payload?: unknown) => {
        scene.stateMachine.transitionTo(next, payload)
      },
      refreshHud: () => scene.refreshHud(),
      addScore: (amount: number) => {
        scene.sessionScore += amount
        scene.refreshHud()
      },
    }
  }

  private refreshHud(): void {
    const weather = this.weatherSystem.get()
    this.hud.setMetrics(
      this.sessionScore,
      this.hungerSystem.getBestScore(),
      this.hungerSystem.getHunger(),
      weather,
    )
  }
}
