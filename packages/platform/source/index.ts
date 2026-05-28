// ---------------------------------------------------------------------------
// @minigame/platform — Public API
// ---------------------------------------------------------------------------

// Types
export type {
  Platform,
  Orientation,
  ControlMode,
  PlatformInputState,
  PlatformInputConfig,
  InputHandler,
  JoystickConfig,
  ButtonDef,
  ButtonsConfig,
  DragToMoveConfig,
  GestureConfig,
  DisplayScaleOptions,
  DisplayMetrics,
  OrientationChangeEvent,
  OrientationListener,
  DisplayChangeListener,
} from './types.ts';

// Main entry point
export { PlatformInput } from './PlatformInput.ts';

// Input handlers
export { DesktopInput } from './DesktopInput.ts';
export { MobileInput } from './MobileInput.ts';

// Detection
export { detectPlatform, detectOrientation, onOrientationChange } from './detect.ts';
export { getRecommendedPixelRatio, getDisplayMetrics, onDisplayChange } from './display.ts';

// Controls (advanced — for direct use or custom composition)
export { VirtualJoystick } from './controls/VirtualJoystick.ts';
export { DualJoystick } from './controls/DualJoystick.ts';
export { TouchButtons } from './controls/TouchButtons.ts';
export { DragToMove } from './controls/DragToMove.ts';
export { GestureInput } from './controls/GestureInput.ts';
export { TapInput } from './controls/TapInput.ts';
export type { TapEvent } from './controls/TapInput.ts';
export type { SwipeDirection } from './controls/GestureInput.ts';
