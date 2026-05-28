// ---------------------------------------------------------------------------
// @minigame/platform — Mobile input aggregator
// ---------------------------------------------------------------------------

import type {
  PlatformInputState,
  PlatformInputConfig,
  InputHandler,
} from './types.ts';

import { VirtualJoystick } from './controls/VirtualJoystick.ts';
import { DualJoystick } from './controls/DualJoystick.ts';
import { TouchButtons } from './controls/TouchButtons.ts';
import { DragToMove } from './controls/DragToMove.ts';
import { GestureInput } from './controls/GestureInput.ts';
import { TapInput } from './controls/TapInput.ts';

/**
 * Mobile input handler — delegates to the appropriate control module(s)
 * based on the configured `ControlMode`.
 *
 * The game only interacts with `MobileInput` via the `InputHandler`
 * interface; the specific control classes are internal implementation
 * details.
 */
export class MobileInput implements InputHandler {
  private joystick?: VirtualJoystick;
  private dualJoystick?: DualJoystick;
  private buttons?: TouchButtons;
  private dragHandler?: DragToMove;
  private gestureHandler?: GestureInput;
  private tapHandler?: TapInput;
  private disposed = false;

  constructor(config: PlatformInputConfig) {
    const container = config.container ?? document.body;

    switch (config.mode) {
      case 'joystick':
        this.joystick = new VirtualJoystick(container, 'left');
        // Buttons are not created by default — the game should supply
        // a ButtonsConfig via a separate method or extend MobileInput.
        // For now, leave buttons undefined; PlatformInputState.action*
        // will be undefined.
        break;

      case 'dual-joystick':
        this.dualJoystick = new DualJoystick(container);
        break;

      case 'drag-to-move':
        this.dragHandler = new DragToMove(container, {
          zone: 'full',
          sensitivity: 1.0,
        });
        break;

      case 'gesture':
        this.gestureHandler = new GestureInput(container);
        break;

      case 'tap-only':
        this.tapHandler = new TapInput(config.canvas);
        break;
    }
  }

  /** Attach optional action buttons (joystick / dual-joystick / drag-to-move). */
  attachButtons(config: ConstructorParameters<typeof TouchButtons>[1]): void {
    if (this.buttons) return;
    const container = this.joystick
      ? (this.joystick as any).zoneEl?.parentElement ?? document.body
      : document.body;
    this.buttons = new TouchButtons(container, config);
  }

  getInput(): PlatformInputState {
    if (this.disposed) return {};

    // --- Joystick ---
    if (this.joystick) {
      const dir = this.joystick.getDirection();
      const btn = this.buttons?.getButtonState();
      return {
        moveX: dir.x,
        moveY: dir.y,
        action1: btn?.action1,
        action2: btn?.action2,
        action3: btn?.action3,
        action4: btn?.action4,
      };
    }

    // --- Dual Joystick ---
    if (this.dualJoystick) {
      const left = this.dualJoystick.getLeftState();
      const right = this.dualJoystick.getRightState();
      const btn = this.buttons?.getButtonState();
      return {
        moveX: left.x,
        moveY: left.y,
        aimX: right.x,
        aimY: right.y,
        action1: right.active || btn?.action1,
        action2: btn?.action2,
        action3: btn?.action3,
        action4: btn?.action4,
      };
    }

    // --- Drag-to-Move ---
    if (this.dragHandler) {
      const dir = this.dragHandler.getDirection();
      const btn = this.buttons?.getButtonState();
      return {
        moveX: dir.x,
        moveY: dir.y,
        action1: btn?.action1,
        action2: btn?.action2,
        action3: btn?.action3,
        action4: btn?.action4,
      };
    }

    // --- Gesture ---
    if (this.gestureHandler) {
      return {
        moveX: this.gestureHandler.moveX,
        moveY: this.gestureHandler.moveY,
        action1: this.gestureHandler.tapped,
        pointerX: this.gestureHandler.tapX,
        pointerY: this.gestureHandler.tapY,
      };
    }

    // --- Tap-only ---
    if (this.tapHandler) {
      const last = this.tapHandler.getLastTap();
      return {
        pointerX: last?.x,
        pointerY: last?.y,
        action1: last !== undefined,
      };
    }

    return {};
  }

  endFrame(): void {
    this.dragHandler?.endFrame();
    this.gestureHandler?.endFrame();
    this.tapHandler?.endFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.joystick?.dispose();
    this.dualJoystick?.dispose();
    this.buttons?.dispose();
    this.dragHandler?.dispose();
    this.gestureHandler?.dispose();
    this.tapHandler?.dispose();
  }
}
