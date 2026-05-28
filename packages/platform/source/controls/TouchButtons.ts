// ---------------------------------------------------------------------------
// @minigame/platform — Touch Action Buttons
// ---------------------------------------------------------------------------

import type { ButtonDef, ButtonsConfig } from '../types.ts';

const DEFAULT_SPACING = 12;
const DEFAULT_SIZE = 56;
const PRIMARY_SIZE = 64;

/**
 * Virtual action buttons for mobile.
 *
 * Supports 1–4 buttons in a diamond layout. Each button tracks its own
 * `pointerId` for multi-touch.
 */
export class TouchButtons {
  readonly state: boolean[];

  private readonly container: HTMLDivElement;
  private readonly buttonEls: HTMLDivElement[] = [];
  private readonly pointerIds: (number | null)[];
  private disposed = false;

  constructor(
    parent: HTMLElement,
    config: ButtonsConfig,
  ) {
    const buttons = config.buttons.slice(0, 4);
    this.state = buttons.map(() => false);
    this.pointerIds = buttons.map(() => null);

    const spacing = config.spacing ?? DEFAULT_SPACING;

    // Container
    this.container = document.createElement('div');
    const cs = this.container.style;
    cs.position = 'fixed';
    cs.right = config.position?.right ?? `max(12px, env(safe-area-inset-right, 12px))`;
    cs.bottom = config.position?.bottom ?? `max(12px, env(safe-area-inset-bottom, 12px))`;
    cs.zIndex = '500';
    cs.touchAction = 'none';
    cs.display = 'flex';
    cs.flexDirection = 'column';
    cs.alignItems = 'center';
    cs.gap = `${spacing}px`;

    // Create buttons (diamond: primary at bottom-center)
    buttons.forEach((def, i) => {
      const el = this.createButton(def, i);
      this.container.appendChild(el);
      this.buttonEls.push(el);
    });

    parent.appendChild(this.container);
  }

  /** Return current button state as a record. */
  getButtonState(): {
    action1: boolean;
    action2: boolean;
    action3: boolean;
    action4: boolean;
  } {
    return {
      action1: this.state[0] ?? false,
      action2: this.state[1] ?? false,
      action3: this.state[2] ?? false,
      action4: this.state[3] ?? false,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.container.remove();
  }

  // --- internals ---

  private createButton(def: ButtonDef, index: number): HTMLDivElement {
    const size = def.size ?? (index === 0 ? PRIMARY_SIZE : DEFAULT_SIZE);
    const el = document.createElement('div');
    const s = el.style;
    s.width = `${size}px`;
    s.height = `${size}px`;
    s.borderRadius = '50%';
    s.background = def.color ?? 'rgba(255,255,255,0.15)';
    s.border = '2px solid rgba(255,255,255,0.4)';
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
    s.fontSize = `${Math.round(size * 0.4)}px`;
    s.userSelect = 'none';
    s.touchAction = 'none';
    s.opacity = '0.7';
    s.transition = 'opacity 0.1s, transform 0.1s';
    s.cursor = 'pointer';
    el.textContent = def.label;

    // Pointer events
    el.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.pointerIds[index] !== null) return;
      e.preventDefault();
      e.stopPropagation();
      this.pointerIds[index] = e.pointerId;
      el.setPointerCapture(e.pointerId);
      this.state[index] = true;
      s.opacity = '1';
      s.transform = 'scale(0.9)';
    });

    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerIds[index]) return;
      this.pointerIds[index] = null;
      this.state[index] = false;
      s.opacity = '0.7';
      s.transform = 'scale(1)';
    };

    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);

    return el;
  }
}
