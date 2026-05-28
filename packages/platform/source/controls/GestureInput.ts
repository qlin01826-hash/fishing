// ---------------------------------------------------------------------------
// @minigame/platform — Gesture input (swipe + tap)
// ---------------------------------------------------------------------------

import type { GestureConfig } from '../types.ts';

export type SwipeDirection = 'up' | 'down' | 'left' | 'right' | null;

const DEFAULT_SWIPE_THRESHOLD = 30;

/**
 * Gesture-based input for games that use discrete directional swipes
 * (endless runner, snake, 2048, etc.).
 *
 * Returns **discrete** values: moveX/Y are -1, 0, or 1 for exactly one
 * frame after a swipe, then reset via `endFrame()`.
 */
export class GestureInput {
  /** Last detected swipe direction (one-frame). */
  swipe: SwipeDirection = null;
  /** Discrete movement values: -1, 0 or 1 (one-frame). */
  moveX = 0;
  moveY = 0;
  /** Whether a tap was detected this frame. */
  tapped = false;
  tapX = 0;
  tapY = 0;

  private readonly threshold: number;
  private readonly zoneEl: HTMLDivElement;
  private pointerId: number | null = null;
  private startX = 0;
  private startY = 0;
  private disposed = false;

  private readonly onDown: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;

  constructor(
    container: HTMLElement,
    config?: GestureConfig,
  ) {
    this.threshold = config?.swipeThreshold ?? DEFAULT_SWIPE_THRESHOLD;

    // Full-screen transparent capture layer
    this.zoneEl = document.createElement('div');
    const zs = this.zoneEl.style;
    zs.position = 'fixed';
    zs.inset = '0';
    zs.zIndex = '490';
    zs.touchAction = 'none';

    this.onDown = (e: PointerEvent) => {
      if (this.pointerId !== null) return;
      e.preventDefault();
      this.pointerId = e.pointerId;
      this.zoneEl.setPointerCapture(e.pointerId);
      this.startX = e.clientX;
      this.startY = e.clientY;
    };

    this.onUp = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;

      const dx = e.clientX - this.startX;
      const dy = e.clientY - this.startY;
      const dist = Math.hypot(dx, dy);

      if (dist < this.threshold) {
        // Tap
        this.tapped = true;
        this.tapX = e.clientX;
        this.tapY = e.clientY;
      } else {
        // Swipe — pick dominant axis
        if (Math.abs(dx) > Math.abs(dy)) {
          this.swipe = dx > 0 ? 'right' : 'left';
          this.moveX = dx > 0 ? 1 : -1;
          this.moveY = 0;
        } else {
          this.swipe = dy > 0 ? 'down' : 'up';
          this.moveX = 0;
          this.moveY = dy > 0 ? 1 : -1;
        }
      }
    };

    this.zoneEl.addEventListener('pointerdown', this.onDown);
    this.zoneEl.addEventListener('pointerup', this.onUp);
    this.zoneEl.addEventListener('pointercancel', this.onUp);

    container.appendChild(this.zoneEl);
  }

  /** Consume the current swipe (returns direction and resets). */
  consumeSwipe(): SwipeDirection {
    const s = this.swipe;
    this.swipe = null;
    this.moveX = 0;
    this.moveY = 0;
    return s;
  }

  /** Reset one-frame events. Call once per game loop iteration. */
  endFrame(): void {
    this.swipe = null;
    this.moveX = 0;
    this.moveY = 0;
    this.tapped = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.zoneEl.removeEventListener('pointerdown', this.onDown);
    this.zoneEl.removeEventListener('pointerup', this.onUp);
    this.zoneEl.removeEventListener('pointercancel', this.onUp);
    this.zoneEl.remove();
  }
}
