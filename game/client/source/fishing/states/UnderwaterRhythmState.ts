import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishDef, FishingStateId } from '../types'
import { FISHING_CONSTANTS } from '../types'
import type { AmbientFish } from '../entities/FishSchool'
import { RhythmTrack } from '../ui/RhythmTrack'
import { sectionForStage } from '../systems/AudioSystem'
import { CatchState } from './CatchState'
import { SailingState } from './SailingState'

interface UnderwaterRhythmPayload {
  ambient?: AmbientFish | null
}

/**
 * Third-person underwater rhythm phase.
 *
 * Design goals:
 * - Deep camera drop for immersion (surface leaves frame), screen-filling
 *   Arcaea-like chart rendered by RhythmTrack
 * - The PENGUIN charges forward into the screen (back view) and reacts to
 *   the chart: dash on taps, glide on holds, dual-wing glide on dual notes
 * - Keep existing battle win/loss semantics (willpower + tension)
 */
export class UnderwaterRhythmState implements IFishingState {
  readonly id: FishingStateId = 'battle'
  private readonly ctx: FishingContext
  private readonly def: FishDef
  private readonly rhythmTrack: RhythmTrack

  private ambient: AmbientFish | null = null
  private willpower = 1
  private trackerT = 0.5
  private readonly safeMin = 0.3
  private readonly safeMax = 0.7
  private outOfZoneMs = 0
  private activePointers = new Set<number>()
  private isSpaceHeld = false
  private isEnding = false

  private dashTimer = 0
  private penguinLean = 0
  private bobT = 0
  private penguin3DX = 0
  private penguin3DY = 0

  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e)
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e)

  constructor(ctx: FishingContext) {
    this.ctx = ctx
    const biter = ctx.activeBiter
    if (!biter) throw new Error('UnderwaterRhythmState entered without active biter')
    this.def = biter.def
    this.rhythmTrack = new RhythmTrack()
    this.rhythmTrack.attachBeatClock(ctx.beatClock)
  }

  enter(payload?: unknown): void {
    const p = payload as UnderwaterRhythmPayload | undefined
    this.ambient = p?.ambient ?? null

    this.ctx.tensionBar.container.visible = true
    this.ctx.willpowerBar.container.visible = true
    this.ctx.pullPanel.container.visible = false
    this.ctx.lurePads.container.visible = false
    this.ctx.noteLane.container.visible = false

    this.rhythmTrack.setViewport(this.ctx.viewport)
    this.ctx.underWaterContainer.addChild(this.rhythmTrack.container)

    // Third-person: the penguin charges forward into the chart (back view).
    this.ctx.penguin.container.visible = true
    this.ctx.penguin.setBackView(true)
    this.ctx.penguin.setUnderwaterState('glide')
    this.ctx.penguin.container.scale.set(1.4)
    // Hide the cast line / hook so it doesn't streak across the dive.
    this.ctx.hook.container.visible = false

    const { waterLineY, maxDepth } = this.ctx.viewport
    this.ctx.cameraYTarget = waterLineY + maxDepth * 0.9

    const intensity = this.ctx.weatherSystem.get().intensity
    const stage = this.ctx.progression.stage
    const lockedBpm = this.ctx.audio.getLockedBpm()
    const bpm = lockedBpm ?? Math.round(stage.bpmBase + (intensity - 0.5) * 12)
    this.ctx.beatClock.setBpm(bpm)
    this.ctx.audio.startGrooveBed()
    this.ctx.audio.resyncScheduler()
    this.ctx.audio.riseToSection(sectionForStage(stage.index))

    this.rhythmTrack.start(this.def, stage.index)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    this.willpower = 1
    this.trackerT = 0.5
    this.outOfZoneMs = 0
    this.isSpaceHeld = false
    this.isEnding = false
    this.penguin3DX = 0
    this.penguin3DY = 200
    this.ctx.penguin.showMessage(t('game.battlePullHint'), 'excited', 1800)
  }

  update(dtSeconds: number): void {
    if (this.isEnding) return
    const nowMs = performance.now()
    this.rhythmTrack.update(dtSeconds, nowMs)

    this.updateHoldDrain(dtSeconds)
    this.updateTension(dtSeconds)
    this.updateBars()
    this.updatePenguin(dtSeconds)
    this.checkOutcomes()
  }

  /**
   * Drive the forward-charging penguin: pick a swim pose from the current
   * input, lean toward the held lane, bob/surge on dashes, and keep it
   * pinned to the lower-centre of the screen (compensating for the camera
   * scroll so it stays glued to the chart's hit zone).
   */
  private updatePenguin(dtSeconds: number): void {
    if (this.dashTimer > 0) this.dashTimer -= dtSeconds
    const bothHeld = this.rhythmTrack.isHoldActive('left') && this.rhythmTrack.isHoldActive('right')

    // Determine pose
    if (this.dashTimer > 0) this.ctx.penguin.setUnderwaterState('dash')
    else if (bothHeld) this.ctx.penguin.setUnderwaterState('glide_dual')
    else this.ctx.penguin.setUnderwaterState('glide')

    const beat = this.rhythmTrack.fractionalBeat()
    const hold = this.rhythmTrack.getActiveHoldPosition(beat)

    // Target 3D coordinates
    let target3DX = 0
    let target3DY = 200 // default Y (near ground)

    if (hold) {
      target3DX = hold.x
      target3DY = hold.y
    } else {
      // If no active hold, let it lean slightly based on keys held
      if (this.rhythmTrack.isHoldActive('left')) target3DX -= 120
      if (this.rhythmTrack.isHoldActive('right')) target3DX += 120
    }

    // Smoothly lerp 3D coordinates
    const lerpSpeed = hold ? 12 : 6 // faster tracking when holding a note
    this.penguin3DX += (target3DX - this.penguin3DX) * Math.min(1, dtSeconds * lerpSpeed)
    this.penguin3DY += (target3DY - this.penguin3DY) * Math.min(1, dtSeconds * lerpSpeed)

    // Calculate lean and rotation based on lateral movement
    const dx = target3DX - this.penguin3DX
    const dy = target3DY - this.penguin3DY
    let targetLean = dx * 0.003 // tilt into curves
    if (hold && hold.type === 'arc') {
      // Extra tilt for curves
      if (hold.curveType === 'wave') targetLean += Math.sin(beat * Math.PI) * 0.25
      else if (hold.curveType === 'helix') targetLean += Math.cos(beat * Math.PI) * 0.3
    }
    this.penguinLean += (targetLean - this.penguinLean) * Math.min(1, dtSeconds * 8)

    // Add organic bobbing
    this.bobT += dtSeconds * (this.dashTimer > 0 ? 14 : 5)
    const bobOffset = Math.sin(this.bobT) * 8
    const surge = this.dashTimer > 0 ? this.dashTimer * 60 : 0

    // Project the penguin's 3D position to 2D screen space!
    // This aligns the penguin perfectly with the 3D track and camera curves!
    const p = this.rhythmTrack.project(this.penguin3DX, this.penguin3DY, this.rhythmTrack.Z_HIT, beat)

    // Set screen position (adding cameraY back since penguin is in aboveWaterContainer)
    this.ctx.penguin.container.position.set(p.x, p.y + bobOffset - surge + this.ctx.cameraY)
    this.ctx.penguin.container.rotation = this.penguinLean

    // Wingtip bubble trails!
    if (hold) {
      const cos = Math.cos(this.penguinLean)
      const sin = Math.sin(this.penguinLean)
      const wingOffset = 45 * 1.4 // scale is 1.4

      // Left wingtip
      const leftX = p.x - wingOffset * cos
      const leftY = p.y - wingOffset * sin
      // Right wingtip
      const rightX = p.x + wingOffset * cos
      const rightY = p.y + wingOffset * sin

      const color = hold.type === 'arc' ? 0x67e8f9 : hold.type === 'dual' ? 0xfb923c : 0x86efac

      if (hold.type === 'dual') {
        this.rhythmTrack.spawnWingtipTrail(leftX, leftY, color)
        this.rhythmTrack.spawnWingtipTrail(rightX, rightY, color)
      } else if (hold.type === 'arc') {
        // Spawn from the wing corresponding to the lane direction
        if (hold.x < 0) this.rhythmTrack.spawnWingtipTrail(leftX, leftY, color)
        else this.rhythmTrack.spawnWingtipTrail(rightX, rightY, color)
      } else {
        // Ground hold: spawn from center/feet or both wings
        this.rhythmTrack.spawnWingtipTrail(p.x, p.y + 20, color)
      }
    }
  }

  private updateHoldDrain(dtSeconds: number): void {
    const stable = this.rhythmTrack.consecutiveMisses === 0
    const holding = this.isSpaceHeld || (this.rhythmTrack.isHoldActive('left') && this.rhythmTrack.isHoldActive('right'))
    if (!holding || !stable) return
    const drain = 0.03 * (this.rhythmTrack.combo > 10 ? 1.45 : 1)
    this.willpower = Math.max(0, this.willpower - drain * dtSeconds)
  }

  private updateTension(dtSeconds: number): void {
    const misses = this.rhythmTrack.consecutiveMisses
    if (misses > 0) {
      const driftDir = misses % 2 === 0 ? 1 : -1
      this.trackerT += driftDir * dtSeconds * 0.16 * Math.min(3, misses)
    } else {
      this.trackerT += (0.5 - this.trackerT) * dtSeconds * 0.85
    }
    this.trackerT = Math.max(0, Math.min(1, this.trackerT))
    const inZone = this.trackerT >= this.safeMin && this.trackerT <= this.safeMax
    if (inZone) this.outOfZoneMs = Math.max(0, this.outOfZoneMs - dtSeconds * 1200)
    else this.outOfZoneMs += dtSeconds * 1000
  }

  private updateBars(): void {
    this.ctx.willpowerBar.setState(this.willpower, this.def.color)
    this.ctx.tensionBar.setState(
      this.trackerT,
      [this.safeMin, this.safeMax],
      Math.min(1, this.outOfZoneMs / FISHING_CONSTANTS.tension_grace_ms),
      this.trackerT < this.safeMin || this.trackerT > this.safeMax,
    )
  }

  private checkOutcomes(): void {
    if (this.outOfZoneMs >= FISHING_CONSTANTS.tension_grace_ms) {
      this.snap()
      return
    }
    if (this.willpower <= 0) this.win()
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.isEnding) return
    const code = e.code
    if (code === 'Space') {
      e.preventDefault()
      if (e.repeat) return
      this.isSpaceHeld = true
      this.rhythmTrack.setHoldState('space', true)
      const j = this.rhythmTrack.registerTap('space', performance.now())
      this.applyHit(j, 0.05)
      return
    }
    const isLeft = code === 'KeyA' || code === 'KeyF' || code === 'ArrowLeft'
    const isRight = code === 'KeyD' || code === 'KeyJ' || code === 'ArrowRight'
    if (isLeft) {
      e.preventDefault()
      if (e.repeat) return
      this.rhythmTrack.setHoldState('left', true)
      // Single-side press scores air/arc glide notes on that lane...
      this.applyHit(this.rhythmTrack.registerTap('left', performance.now()), 0.05)
      // ...and both sides together score dual notes.
      this.tryDualHit()
    }
    if (isRight) {
      e.preventDefault()
      if (e.repeat) return
      this.rhythmTrack.setHoldState('right', true)
      this.applyHit(this.rhythmTrack.registerTap('right', performance.now()), 0.05)
      this.tryDualHit()
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    const code = e.code
    if (code === 'Space') {
      e.preventDefault()
      this.isSpaceHeld = false
      this.rhythmTrack.setHoldState('space', false)
    }
    const isLeft = code === 'KeyA' || code === 'KeyF' || code === 'ArrowLeft'
    const isRight = code === 'KeyD' || code === 'KeyJ' || code === 'ArrowRight'
    if (isLeft) {
      e.preventDefault()
      this.rhythmTrack.setHoldState('left', false)
    }
    if (isRight) {
      e.preventDefault()
      this.rhythmTrack.setHoldState('right', false)
    }
  }

  private tryDualHit(): void {
    if (!this.rhythmTrack.isHoldActive('left') || !this.rhythmTrack.isHoldActive('right')) return
    const j = this.rhythmTrack.registerTap('left', performance.now())
    this.applyHit(j, 0.08)
  }

  /**
   * Apply a successful tap: drain willpower, kick the dash animation, and
   * play a height-layered hit sound (ground "thock" vs air "shimmer").
   */
  private applyHit(j: 'perfect' | 'good' | 'miss' | null, drain: number): void {
    if (!j || j === 'miss') return
    this.willpower = Math.max(0, this.willpower - drain)
    this.dashTimer = 0.22
    const hit = this.rhythmTrack.lastHit
    const perfect = j === 'perfect'
    if (hit?.height === 'air') this.ctx.audio.playAirHit(perfect)
    else this.ctx.audio.playGroundHit(perfect)
  }

  onPointerDown(_x: number, _y: number, pointerId: number): void {
    if (this.isEnding) return
    this.activePointers.add(pointerId)
    if (this.activePointers.size === 1) {
      this.isSpaceHeld = true
      this.rhythmTrack.setHoldState('space', true)
      const j = this.rhythmTrack.registerTap('space', performance.now())
      this.applyHit(j, 0.05)
      return
    }
    this.rhythmTrack.setHoldState('left', true)
    this.rhythmTrack.setHoldState('right', true)
    this.tryDualHit()
  }

  onPointerMove(): void {}

  onPointerUp(_x: number, _y: number, pointerId: number): void {
    this.activePointers.delete(pointerId)
    if (this.activePointers.size === 0) {
      this.isSpaceHeld = false
      this.rhythmTrack.setHoldState('space', false)
      this.rhythmTrack.setHoldState('left', false)
      this.rhythmTrack.setHoldState('right', false)
      return
    }
    this.rhythmTrack.setHoldState('left', false)
    this.rhythmTrack.setHoldState('right', false)
  }

  exit(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)

    this.rhythmTrack.stop()
    this.ctx.underWaterContainer.removeChild(this.rhythmTrack.container)
    this.rhythmTrack.container.destroy({ children: true })

    this.ctx.cameraYTarget = 0
    this.ctx.penguin.container.visible = true
    this.ctx.penguin.setBackView(false)
    this.ctx.penguin.setUnderwaterState('neutral')
    this.ctx.penguin.container.scale.set(1)
    this.ctx.penguin.container.rotation = 0
    this.ctx.hook.container.visible = true
    this.ctx.tensionBar.container.visible = false
    this.ctx.willpowerBar.container.visible = false
    this.ctx.audio.relaxToBed()
  }

  private win(): void {
    if (this.isEnding) return
    this.isEnding = true
    // Finale: penguin lunges forward and gulps the fish down.
    this.ctx.penguin.setUnderwaterState('eat')
    this.ctx.audio.playFanfare()
    this.ctx.shake(8, 0.35)
    setTimeout(() => {
      this.ctx.goTo(new CatchState(this.ctx), { def: this.def })
    }, 700)
  }

  private snap(): void {
    if (this.isEnding) return
    this.isEnding = true
    this.ctx.audio.playFail()
    this.ctx.progression.reportSnap()
    this.ctx.shake(14, 0.6)
    this.ctx.activeBiter = null
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.penguin.showMessage(t('game.tensionBroken'), 'worried', 1800)
    this.ctx.goTo(new SailingState(this.ctx))
  }
}
