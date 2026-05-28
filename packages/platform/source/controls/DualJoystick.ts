// ---------------------------------------------------------------------------
// @minigame/platform — Dual Joystick (left = move, right = aim)
// ---------------------------------------------------------------------------

import type { JoystickConfig } from '../types.ts';
import { VirtualJoystick } from './VirtualJoystick.ts';

/**
 * Manages two VirtualJoystick instances for twin-stick style games.
 *
 * Left stick controls movement, right stick controls aiming / firing.
 * Each stick tracks its own pointerId so both can be used simultaneously.
 */
export class DualJoystick {
  private readonly left: VirtualJoystick;
  private readonly right: VirtualJoystick;

  constructor(container: HTMLElement, leftConfig?: JoystickConfig, rightConfig?: JoystickConfig) {
    this.left = new VirtualJoystick(container, 'left', {
      zone: { width: '50vw', height: '40vh' },
      ...leftConfig,
    });

    this.right = new VirtualJoystick(container, 'right', {
      zone: { width: '50vw', height: '40vh' },
      ...rightConfig,
    });
  }

  getLeftState(): { x: number; y: number; active: boolean } {
    return { ...this.left.getDirection(), active: this.left.active };
  }

  getRightState(): { x: number; y: number; active: boolean } {
    return { ...this.right.getDirection(), active: this.right.active };
  }

  dispose(): void {
    this.left.dispose();
    this.right.dispose();
  }
}
