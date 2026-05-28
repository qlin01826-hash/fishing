// ---------------------------------------------------------------------------
// @minigame/platform — Drag-to-Move input (shoot-em-up, bullet-hell)
// ---------------------------------------------------------------------------

import type { DragToMoveConfig } from '../types.ts';

const DEFAULT_SENSITIVITY = 1.0;

/**
 * Direct touch movement — the game object follows the finger.
 *
 * Returns **pixel deltas** per frame (not normalised -1…1).
 * The game's movement system applies the deltas directly and clamps to
 * screen bounds.
 */
export class DragToMove {
  /** Pixel delta since last `endFrame()`. */
  deltaX = 0;
  deltaY = 0;
  /** Whether a drag is currently active. */
  active = false;

  private readonly sensitivity: number;
  private readonly zoneEl: HTMLDivElement;
  private pointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private disposed = false;

  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;

  constructor(
    container: HTMLElement,
    config?: DragToMoveConfig,
  ) {
    this.sensitivity = config?.sensitivity ?? DEFAULT_SENSITIVITY;
    const zone = config?.zone ?? 'full';

    // Invisible touch zone
    this.zoneEl = document.createElement('div');
    const zs = this.zoneEl.style;
    zs.position = 'fixed';
    zs.left = '0';
    zs.width = '100%';
    zs.zIndex = '490';
    zs.touchAction = 'none';

    if (zone === 'bottom-half') {
      zs.top = '50%';
      zs.height = '50%';
    } else {
      zs.top = '0';
      zs.height = '100%';
    }

    this.onDown = (e: PointerEvent) => {
      if (this.pointerId !== null) return;
      e.preventDefault();
      this.pointerId = e.pointerId;
      this.zoneEl.setPointerCapture(e.pointerId);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.active = true;
    };

    this.onMove = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      e.preventDefault();
      this.deltaX += (e.clientX - this.lastX) * this.sensitivity;
      this.deltaY += (e.clientY - this.lastY) * this.sensitivity;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };

    this.onUp = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.active = false;
    };

    this.zoneEl.addEventListener('pointerdown', this.onDown);
    this.zoneEl.addEventListener('pointermove', this.onMove);
    this.zoneEl.addEventListener('pointerup', this.onUp);
    this.zoneEl.addEventListener('pointercancel', this.onUp);
    this.zoneEl.addEventListener('pointerleave', this.onUp);

    container.appendChild(this.zoneEl);
  }

  /** Return accumulated pixel deltas since last endFrame(). */
  getDirection(): { x: number; y: number } {
    return { x: this.deltaX, y: this.deltaY };
  }

  /** Reset per-frame deltas. Call once per game loop iteration. */
  endFrame(): void {
    this.deltaX = 0;
    this.deltaY = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.zoneEl.removeEventListener('pointerdown', this.onDown);
    this.zoneEl.removeEventListener('pointermove', this.onMove);
    this.zoneEl.removeEventListener('pointerup', this.onUp);
    this.zoneEl.removeEventListener('pointercancel', this.onUp);
    this.zoneEl.removeEventListener('pointerleave', this.onUp);
    this.zoneEl.remove();
  }
}
