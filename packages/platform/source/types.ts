// ---------------------------------------------------------------------------
// @minigame/platform — Type definitions
// ---------------------------------------------------------------------------

/** Detected runtime platform. */
export type Platform = 'desktop' | 'mobile';

/** Screen orientation. */
export type Orientation = 'landscape' | 'portrait';

/** Mobile control mode — chosen per game type. */
export type ControlMode =
  | 'joystick'
  | 'dual-joystick'
  | 'drag-to-move'
  | 'gesture'
  | 'tap-only';

// ---------------------------------------------------------------------------
// Input state
// ---------------------------------------------------------------------------

/**
 * Unified input state returned by all control modes.
 *
 * Fields that a specific mode doesn't use are left `undefined`.
 * - `moveX` / `moveY`: continuous -1…1 (joystick, dual-joystick, drag-to-move)
 *   or discrete -1/0/1 (gesture). `undefined` for tap-only.
 * - `aimX` / `aimY`: only set by dual-joystick (right stick).
 * - `action1`–`action4`: virtual button state. `undefined` when no buttons.
 * - `pause`: ESC key (desktop) or pause button (mobile).
 * - `pointerX` / `pointerY`: last tap/click screen coordinates.
 */
export interface PlatformInputState {
  moveX?: number;
  moveY?: number;
  aimX?: number;
  aimY?: number;
  action1?: boolean;
  action2?: boolean;
  action3?: boolean;
  action4?: boolean;
  pause?: boolean;
  pointerX?: number;
  pointerY?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Main configuration for PlatformInput. */
export interface PlatformInputConfig {
  /** Mobile control mode (required). */
  mode: ControlMode;
  /** Force a specific platform regardless of detection (useful for testing). */
  forceMode?: Platform;
  /** Game canvas element — used by TapInput and DragToMove. */
  canvas?: HTMLCanvasElement;
  /** Container for virtual controls. Defaults to `document.body`. */
  container?: HTMLElement;
  /** Virtual control scale factor (default 1.0). */
  scale?: number;
}

/** Configuration for a single VirtualJoystick instance. */
export interface JoystickConfig {
  /** Base diameter in px (default 120). */
  size?: number;
  /** Deadzone threshold 0…1 (default 0.15). */
  deadzone?: number;
  /** Active touch zone dimensions. */
  zone?: { width: string; height: string };
  /** CSS position overrides. */
  position?: { left?: string; bottom?: string; right?: string; top?: string };
}

/** Configuration for TouchButtons. */
export interface ButtonDef {
  /** Label shown on the button (emoji or short text). */
  label: string;
  /** CSS background colour (default '#ffffff22'). */
  color?: string;
  /** Diameter in px (default 56, primary = 64). */
  size?: number;
}

export interface ButtonsConfig {
  /** Button definitions (1–4). */
  buttons: ButtonDef[];
  /** Spacing between buttons in px (default 12). */
  spacing?: number;
  /** CSS position overrides for the button container. */
  position?: { right?: string; bottom?: string };
}

/** Configuration for DragToMove. */
export interface DragToMoveConfig {
  /** Touch zone: full screen or bottom half (default 'full'). */
  zone?: 'full' | 'bottom-half';
  /** Sensitivity multiplier (default 1.0). */
  sensitivity?: number;
}

/** Configuration for GestureInput. */
export interface GestureConfig {
  /** Minimum swipe distance in px (default 30). */
  swipeThreshold?: number;
}

/** High-DPI render scale configuration. */
export interface DisplayScaleOptions {
  /** Minimum supported device pixel ratio (default `1`). */
  minPixelRatio?: number;
  /** Maximum supported device pixel ratio (default `2`). */
  maxPixelRatio?: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Payload for orientation change events. */
export interface OrientationChangeEvent {
  orientation: Orientation;
  width: number;
  height: number;
}

/** Callback types. */
export type OrientationListener = (event: OrientationChangeEvent) => void;

/** Current viewport + recommended render scale. */
export interface DisplayMetrics {
  pixelRatio: number;
  width: number;
  height: number;
}

/** Callback for display metric changes. */
export type DisplayChangeListener = (metrics: DisplayMetrics) => void;

// ---------------------------------------------------------------------------
// Internal contract — implemented by DesktopInput and MobileInput
// ---------------------------------------------------------------------------

/** Shared interface for input handlers. */
export interface InputHandler {
  getInput(): PlatformInputState;
  endFrame(): void;
  dispose(): void;
}
