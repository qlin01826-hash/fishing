// ---------------------------------------------------------------------------
// @minigame/platform — Virtual Joystick (follow-the-thumb)
// ---------------------------------------------------------------------------

import type { JoystickConfig } from '../types.ts';

const DEFAULTS = {
  size: 120,
  deadzone: 0.15,
  zone: { width: '50vw', height: '40vh' },
} as const;

/**
 * A single virtual joystick that appears where the user touches.
 *
 * Used once for `joystick` mode, and twice (left + right) for
 * `dual-joystick` mode.
 */
export class VirtualJoystick {
  /** Normalised direction: -1…1 per axis (0 inside deadzone). */
  x = 0;
  y = 0;
  /** Whether the joystick is currently being held. */
  active = false;

  private readonly maxRadius: number;
  private readonly deadzone: number;

  // DOM
  private readonly zoneEl: HTMLDivElement;
  private readonly ghostEl: HTMLDivElement;
  private readonly baseEl: HTMLDivElement;
  private readonly knobEl: HTMLDivElement;

  // Tracking
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;

  // Bound handlers
  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;

  private disposed = false;

  constructor(
    container: HTMLElement,
    private readonly side: 'left' | 'right' = 'left',
    config?: JoystickConfig,
  ) {
    const size = config?.size ?? DEFAULTS.size;
    this.maxRadius = size / 2;
    this.deadzone = config?.deadzone ?? DEFAULTS.deadzone;
    const zone = config?.zone ?? DEFAULTS.zone;

    // --- Touch zone (invisible, captures pointer) ---
    this.zoneEl = document.createElement('div');
    const zs = this.zoneEl.style;
    zs.position = 'fixed';
    zs.bottom = '0';
    zs.width = zone.width;
    zs.height = zone.height;
    zs.zIndex = '500';
    zs.touchAction = 'none';
    if (config?.position) {
      if (config.position.left) zs.left = config.position.left;
      if (config.position.right) zs.right = config.position.right;
      if (config.position.bottom) zs.bottom = config.position.bottom;
      if (config.position.top) zs.top = config.position.top;
    } else {
      zs[this.side === 'left' ? 'left' : 'right'] = '0';
    }

    // --- Ghost indicator (dashed ring, shown when idle) ---
    this.ghostEl = document.createElement('div');
    const gs = this.ghostEl.style;
    gs.position = 'absolute';
    gs.width = `${size}px`;
    gs.height = `${size}px`;
    gs.borderRadius = '50%';
    gs.border = '2px dashed rgba(255,255,255,0.25)';
    gs.left = '50%';
    gs.top = '50%';
    gs.transform = 'translate(-50%, -50%)';
    gs.pointerEvents = 'none';
    this.zoneEl.appendChild(this.ghostEl);

    // --- Base (appears at touch point) ---
    this.baseEl = document.createElement('div');
    const bs = this.baseEl.style;
    bs.position = 'fixed';
    bs.width = `${size}px`;
    bs.height = `${size}px`;
    bs.borderRadius = '50%';
    bs.background = 'rgba(255,255,255,0.12)';
    bs.border = '2px solid rgba(255,255,255,0.3)';
    bs.display = 'none';
    bs.pointerEvents = 'none';
    bs.zIndex = '501';

    // --- Knob ---
    const knobSize = Math.round(size * 0.42);
    this.knobEl = document.createElement('div');
    const ks = this.knobEl.style;
    ks.position = 'fixed';
    ks.width = `${knobSize}px`;
    ks.height = `${knobSize}px`;
    ks.borderRadius = '50%';
    ks.background = 'rgba(255,255,255,0.5)';
    ks.display = 'none';
    ks.pointerEvents = 'none';
    ks.zIndex = '502';

    // --- Events ---
    this.onDown = (e: PointerEvent) => {
      if (this.pointerId !== null) return;
      e.preventDefault();
      this.pointerId = e.pointerId;
      this.zoneEl.setPointerCapture(e.pointerId);
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.active = true;

      // Show base + knob at touch point
      this.baseEl.style.display = 'block';
      this.knobEl.style.display = 'block';
      this.ghostEl.style.display = 'none';
      this.positionBase(e.clientX, e.clientY);
      this.positionKnob(e.clientX, e.clientY);
    };

    this.onMove = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      e.preventDefault();
      this.updateFromPointer(e.clientX, e.clientY);
    };

    this.onUp = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.reset();
    };

    this.zoneEl.addEventListener('pointerdown', this.onDown);
    this.zoneEl.addEventListener('pointermove', this.onMove);
    this.zoneEl.addEventListener('pointerup', this.onUp);
    this.zoneEl.addEventListener('pointercancel', this.onUp);
    this.zoneEl.addEventListener('pointerleave', this.onUp);

    // Mount
    container.appendChild(this.zoneEl);
    container.appendChild(this.baseEl);
    container.appendChild(this.knobEl);
  }

  /** Return current normalised direction. */
  getDirection(): { x: number; y: number } {
    return { x: this.x, y: this.y };
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
    this.baseEl.remove();
    this.knobEl.remove();
  }

  // --- internals ---

  private updateFromPointer(cx: number, cy: number): void {
    const dx = cx - this.originX;
    const dy = cy - this.originY;
    const dist = Math.hypot(dx, dy);

    // Clamp to max radius
    const clamped = Math.min(dist, this.maxRadius);
    const angle = Math.atan2(dy, dx);
    const clampedX = Math.cos(angle) * clamped;
    const clampedY = Math.sin(angle) * clamped;

    // Normalise to -1…1 with deadzone
    const norm = clamped / this.maxRadius;
    if (norm < this.deadzone) {
      this.x = 0;
      this.y = 0;
    } else {
      this.x = (clampedX / this.maxRadius);
      this.y = (clampedY / this.maxRadius);
    }

    // Position knob
    this.positionKnob(this.originX + clampedX, this.originY + clampedY);
  }

  private reset(): void {
    this.pointerId = null;
    this.x = 0;
    this.y = 0;
    this.active = false;
    this.baseEl.style.display = 'none';
    this.knobEl.style.display = 'none';
    this.ghostEl.style.display = '';
  }

  private positionBase(cx: number, cy: number): void {
    const half = this.maxRadius;
    this.baseEl.style.left = `${cx - half}px`;
    this.baseEl.style.top = `${cy - half}px`;
  }

  private positionKnob(cx: number, cy: number): void {
    const r = parseInt(this.knobEl.style.width) / 2;
    this.knobEl.style.left = `${cx - r}px`;
    this.knobEl.style.top = `${cy - r}px`;
  }
}
