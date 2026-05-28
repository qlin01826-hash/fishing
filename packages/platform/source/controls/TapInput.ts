// ---------------------------------------------------------------------------
// @minigame/platform — Tap-only input (board games, puzzles, card games)
// ---------------------------------------------------------------------------

export interface TapEvent {
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Pure tap input — **no DOM overlays**.
 *
 * The game canvas fills the entire screen and handles all hit-testing.
 * This handler simply records pointer-up events so the game can query
 * them via `consumeTaps()`.
 */
export class TapInput {
  private readonly taps: TapEvent[] = [];
  private disposed = false;

  private readonly onDown: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;
  private readonly target: HTMLElement;

  constructor(canvas?: HTMLCanvasElement) {
    this.target = canvas ?? document.body;

    // Prevent default to avoid scroll / zoom
    this.onDown = (e: PointerEvent) => {
      e.preventDefault();
    };

    this.onUp = (e: PointerEvent) => {
      e.preventDefault();
      this.taps.push({
        x: e.clientX,
        y: e.clientY,
        timestamp: performance.now(),
      });
    };

    this.target.addEventListener('pointerdown', this.onDown);
    this.target.addEventListener('pointerup', this.onUp);
    this.target.style.touchAction = 'none';
  }

  /** Return and clear all taps since last call. */
  consumeTaps(): TapEvent[] {
    return this.taps.splice(0);
  }

  /** Return the most recent tap position, or undefined if none. */
  getLastTap(): TapEvent | undefined {
    return this.taps[this.taps.length - 1];
  }

  /** Clear buffered taps. Called once per game loop iteration. */
  endFrame(): void {
    this.taps.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointerup', this.onUp);
  }
}
