// ---------------------------------------------------------------------------
// @minigame/platform — Desktop (keyboard + mouse) input handler
// ---------------------------------------------------------------------------

import type { PlatformInputState, InputHandler } from './types.ts';

/** Default key bindings (WASD + JKLE + ESC). */
const DEFAULT_BINDINGS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  action1: ['KeyJ'],
  action2: ['KeyK'],
  action3: ['KeyL'],
  action4: ['KeyE'],
  pause: ['Escape', 'KeyP'],
} as const;

type BindingKey = keyof typeof DEFAULT_BINDINGS;

export class DesktopInput implements InputHandler {
  private readonly keys = new Map<string, boolean>();
  private readonly justPressed = new Set<string>();
  private pointerX = 0;
  private pointerY = 0;
  private disposed = false;

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onClick: (e: MouseEvent) => void;

  constructor(private readonly canvas?: HTMLCanvasElement) {
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!this.keys.get(e.code)) {
        this.justPressed.add(e.code);
      }
      this.keys.set(e.code, true);
    };

    this.onKeyUp = (e: KeyboardEvent) => {
      this.keys.set(e.code, false);
    };

    this.onMouseMove = (e: MouseEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
    };

    this.onClick = (e: MouseEvent) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    (this.canvas ?? window).addEventListener('click', this.onClick as EventListener);
  }

  getInput(): PlatformInputState {
    if (this.disposed) return {};

    // Continuous movement: -1 / 0 / 1 per axis
    const rawX = (this.isHeld('right') ? 1 : 0) - (this.isHeld('left') ? 1 : 0);
    const rawY = (this.isHeld('down') ? 1 : 0) - (this.isHeld('up') ? 1 : 0);

    // Normalise diagonals
    let moveX = rawX;
    let moveY = rawY;
    if (rawX !== 0 && rawY !== 0) {
      const inv = 1 / Math.SQRT2;
      moveX = rawX * inv;
      moveY = rawY * inv;
    }

    return {
      moveX,
      moveY,
      action1: this.isJustPressed('action1'),
      action2: this.isJustPressed('action2'),
      action3: this.isJustPressed('action3'),
      action4: this.isJustPressed('action4'),
      pause: this.isJustPressed('pause'),
      pointerX: this.pointerX,
      pointerY: this.pointerY,
    };
  }

  endFrame(): void {
    this.justPressed.clear();
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    (this.canvas ?? window).removeEventListener('click', this.onClick as EventListener);
  }

  // --- helpers ---

  private isHeld(binding: BindingKey): boolean {
    return DEFAULT_BINDINGS[binding].some((code) => this.keys.get(code));
  }

  private isJustPressed(binding: BindingKey): boolean {
    return DEFAULT_BINDINGS[binding].some((code) => this.justPressed.has(code));
  }
}
