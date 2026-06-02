import { t } from '@minigame/i18n'
import type { IFishingState } from '../StateMachine'
import type { FishingContext } from '../FishingContext'
import type { FishingStateId } from '../types'
import { pickCommissionFish } from '../data/FishCatalog'
import { SinkingState } from './SinkingState'

/**
 * Idle "we're at sea, waiting" phase.
 *
 * The boat bobs, the penguin posts a commission for a specific fish. A
 * beat ring pulses on the rod tip; a single tap casts the hook, and the
 * closer that tap lands to the beat the farther/deeper it flies — so
 * casting itself is a rhythm action.
 */
export class SailingState implements IFishingState {
  readonly id: FishingStateId = 'sailing'
  private readonly ctx: FishingContext

  constructor(ctx: FishingContext) {
    this.ctx = ctx
  }

  enter(): void {
    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.castPreview.hide()
    this.ctx.reelButtons.setVisible(false)
    this.ctx.eventOverlay.hide()

    // Roll a fresh commission whenever we re-enter sailing (covers boot
    // and the post-catch return). The penguin's mood reflects hunger.
    if (!this.ctx.commissionFish) {
      this.ctx.commissionFish = pickCommissionFish(this.ctx.hungerSystem.getHunger(), Math.random)
    }
    this.ctx.penguin.showRequest(this.ctx.commissionFish)

    // Difficulty climbs every catch, but we only announce when the run
    // crosses into a new NAMED ZONE (5× per run) so the banner never
    // spams. The deepening visuals + faster music carry the per-stage
    // escalation silently in between.
    if (this.ctx.progression.consumeZoneUp()) {
      const zoneName = t(`stage.${this.ctx.progression.stage.name}`)
      this.ctx.penguin.showMessage(t('game.enterStage', { name: zoneName }), 'excited', 2600)
      this.ctx.shake(5, 0.4)
    } else {
      // Clear the per-stage flag so it doesn't leak; no announcement.
      this.ctx.progression.consumeStageUp()
    }
  }

  update(_dtSeconds: number, _elapsedMs: number): void {
    // Mood mapping for the idle penguin (overrides showMessage timers expiring)
    const hunger = this.ctx.hungerSystem.getHunger()
    if (hunger > 0.85) this.ctx.penguin.setMood('weak')
    else if (hunger > 0.6) this.ctx.penguin.setMood('sad')
    else if (hunger > 0.3) this.ctx.penguin.setMood('neutral')
    else this.ctx.penguin.setMood('request')

    // Beat-synced cast cue: flash a ring at the rod tip on every beat so
    // the player can tap ON the beat for a perfect cast. Only meaningful
    // once the clock is running (after the first gesture unlocks audio).
    const clock = this.ctx.beatClock
    if (clock.started) {
      const phase = clock.phase()
      const pulse = phase < 0.25 ? 1 - phase / 0.25 : 0
      this.ctx.castPreview.showBeatCue(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY, pulse)
    }
  }

  onPointerDown(_x: number, _y: number, _pointerId: number): void {
    // ---- On-beat tap cast ----
    // A single tap flings the hook. Timing vs. the beat sets the power:
    // a dead-on tap casts at full strength (reaches the deeper, rarer
    // fish); a sloppy tap still casts, just shorter/shallower. This makes
    // casting part of the rhythm instead of a separate drag gesture.
    const clock = this.ctx.beatClock
    const beatMs = Math.max(1, clock.beatIntervalSec * 1000)
    const offMs = clock.started ? Math.abs(clock.msFromNearestBeat()) : beatMs * 0.5
    // off: 0 = perfectly on the beat, 1 = a full half-beat away (worst).
    const off = Math.min(1, offMs / (beatMs * 0.5))
    const accuracy = 1 - off
    const power = 0.5 + accuracy * 0.5 // 0.5 (sloppy) .. 1.0 (on-beat)

    const { width, waterLineY, maxDepth } = this.ctx.viewport
    const speedMax = Math.min(820, Math.max(260, width * 0.4))
    const speed = 220 + power * (speedMax - 220)
    // Forward-up arc out over the open water (rod points out to sea).
    const ux = 0.5
    const uy = -0.86
    const targetDepthY = waterLineY + maxDepth * power

    this.ctx.hook.resetToRod(this.ctx.boat.rodTipX, this.ctx.boat.rodTipY)
    this.ctx.castPreview.hide()
    this.ctx.audio.playCast(power)

    // Timing feedback.
    if (off < 0.18) {
      this.ctx.penguin.showMessage(t('game.castPerfect'), 'excited', 1100)
      this.ctx.shake(4, 0.22)
    } else if (off < 0.45) {
      this.ctx.penguin.showMessage(t('game.castGood'), 'happy', 1000)
    }

    this.ctx.hook.launch(ux * speed, uy * speed, targetDepthY)
    this.ctx.goTo(new SinkingState(this.ctx))
  }

  exit(): void {
    // Persistent request stays alive across the cast cycle so the player
    // can keep checking what they're supposed to catch.
    this.ctx.castPreview.hide()
  }
}
