// ---------------------------------------------------------------------------
// @minigame/platform — Unified entry point
// ---------------------------------------------------------------------------

import type {
  Platform,
  Orientation,
  ControlMode,
  PlatformInputState,
  PlatformInputConfig,
  InputHandler,
  OrientationListener,
} from './types.ts';

import { detectPlatform, detectOrientation, onOrientationChange } from './detect.ts';
import { DesktopInput } from './DesktopInput.ts';
import { MobileInput } from './MobileInput.ts';

/**
 * Main API surface for platform-adaptive input.
 *
 * Usage:
 * ```ts
 * const input = new PlatformInput({ mode: 'joystick', canvas: renderer.domElement });
 *
 * function update() {
 *   const state = input.getInput();
 *   // use state.moveX, state.moveY, state.action1, …
 *   input.endFrame();
 * }
 *
 * // cleanup
 * input.dispose();
 * ```
 */
export class PlatformInput {
  /** Detected (or forced) platform. */
  readonly platform: Platform;
  /** Configured control mode. */
  readonly mode: ControlMode;
  /** Current screen orientation. */
  orientation: Orientation;

  private readonly handler: InputHandler;
  private removeOrientationListener: (() => void) | null = null;
  private disposed = false;

  constructor(config: PlatformInputConfig) {
    this.platform = detectPlatform(config.forceMode);
    this.mode = config.mode;
    this.orientation = detectOrientation();

    if (this.platform === 'mobile') {
      this.handler = new MobileInput(config);
    } else {
      this.handler = new DesktopInput(config.canvas);
    }

    // Track orientation
    this.removeOrientationListener = onOrientationChange((ev) => {
      this.orientation = ev.orientation;
    });
  }

  /** Read current input state. Safe to call multiple times per frame. */
  getInput(): PlatformInputState {
    if (this.disposed) return {};
    return this.handler.getInput();
  }

  /** Reset one-frame events (taps, swipes, just-pressed keys). */
  endFrame(): void {
    this.handler.endFrame();
  }

  /** Convenience: is the current platform mobile? */
  isMobile(): boolean {
    return this.platform === 'mobile';
  }

  /**
   * Register a callback for orientation / resize changes.
   * Returns an unsubscribe function.
   */
  onOrientationChange(callback: OrientationListener): () => void {
    return onOrientationChange(callback);
  }

  /**
   * Access the underlying MobileInput for advanced operations
   * (e.g. attaching buttons after construction).
   *
   * Returns `null` on desktop.
   */
  getMobileInput(): MobileInput | null {
    if (this.handler instanceof MobileInput) return this.handler;
    return null;
  }

  /** Remove all listeners and DOM elements. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handler.dispose();
    this.removeOrientationListener?.();
    this.removeOrientationListener = null;
  }
}
