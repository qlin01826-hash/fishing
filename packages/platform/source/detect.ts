// ---------------------------------------------------------------------------
// @minigame/platform — Runtime platform & orientation detection
// ---------------------------------------------------------------------------

import type { Platform, Orientation, OrientationChangeEvent, OrientationListener } from './types.ts';

/**
 * Detect the current platform using capability queries.
 *
 * Priority: `forceMode` > `pointer: coarse` media query > `ontouchstart` +
 * `maxTouchPoints` > fallback to `'desktop'`.
 */
export function detectPlatform(forceMode?: Platform): Platform {
  if (forceMode) return forceMode;

  // Prefer media query — most reliable cross-browser signal
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    return 'mobile';
  }

  // Fallback: touch capability check
  if (
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0))
  ) {
    return 'mobile';
  }

  return 'desktop';
}

/** Return current screen orientation based on viewport dimensions. */
export function detectOrientation(): Orientation {
  return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
}

/**
 * Register a callback for orientation / resize changes.
 *
 * Returns an unsubscribe function that removes the listeners.
 */
export function onOrientationChange(callback: OrientationListener): () => void {
  let last = detectOrientation();

  const handler = () => {
    const current = detectOrientation();
    // Only fire when orientation actually changes, or on any resize
    if (current !== last) {
      last = current;
    }
    callback({
      orientation: current,
      width: window.innerWidth,
      height: window.innerHeight,
    });
  };

  window.addEventListener('resize', handler);
  window.addEventListener('orientationchange', handler);

  return () => {
    window.removeEventListener('resize', handler);
    window.removeEventListener('orientationchange', handler);
  };
}
