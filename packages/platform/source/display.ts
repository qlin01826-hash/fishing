// ---------------------------------------------------------------------------
// @minigame/platform — High-DPI / display helpers
// ---------------------------------------------------------------------------

import type {
  DisplayChangeListener,
  DisplayMetrics,
  DisplayScaleOptions,
} from './types.ts';

function clampPixelRatio(value: number, options: DisplayScaleOptions = {}): number {
  const min = options.minPixelRatio ?? 1;
  const max = options.maxPixelRatio ?? 2;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.max(low, Math.min(value, high));
}

/** Return the recommended render pixel ratio for the current display. */
export function getRecommendedPixelRatio(options: DisplayScaleOptions = {}): number {
  if (typeof window === 'undefined') {
    return 1;
  }

  const raw = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  return clampPixelRatio(raw || 1, options);
}

/** Return current viewport dimensions plus the recommended pixel ratio. */
export function getDisplayMetrics(options: DisplayScaleOptions = {}): DisplayMetrics {
  if (typeof window === 'undefined') {
    return {
      pixelRatio: 1,
      width: 0,
      height: 0,
    };
  }

  return {
    pixelRatio: getRecommendedPixelRatio(options),
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

/**
 * Watch viewport / DPR changes.
 *
 * The callback only fires when width, height or recommended pixel ratio changes.
 */
export function onDisplayChange(
  callback: DisplayChangeListener,
  options: DisplayScaleOptions = {},
): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  let last = getDisplayMetrics(options);
  let frameId: number | null = null;

  const emitIfChanged = () => {
    frameId = null;
    const next = getDisplayMetrics(options);
    if (
      next.pixelRatio !== last.pixelRatio ||
      next.width !== last.width ||
      next.height !== last.height
    ) {
      last = next;
      callback(next);
    }
  };

  const schedule = () => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(emitIfChanged);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);

  return () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  };
}
