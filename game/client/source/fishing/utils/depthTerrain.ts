/** Pixel shift applied to seabed sampling — world scrolls under the boat. */
export function voyageScrollX(scrollPx: number): number {
  return Math.max(0, scrollPx)
}

/** Map sailed distance to a 0..1 visual-depth factor for a given viewport. */
export function voyageVisualT(scrollPx: number, width: number): number {
  const span = Math.max(400, width * 4.5)
  return Math.max(0, Math.min(1, scrollPx / span))
}

/** Combine stage milestone with live scroll for water colour / sand fade. */
export function blendDepthMood(stageMood: number, scrollPx: number, width: number): number {
  const v = voyageVisualT(scrollPx, width)
  return Math.max(stageMood, v)
}

/**
 * Sloping seabed height at screen-x.
 * Left starts as beach shelf; scroll shifts the boat into open ocean.
 */
export function seabedY(
  x: number,
  width: number,
  waterLineY: number,
  maxDepth: number,
  depthMood: number,
  scrollPx = 0,
): number {
  const mood = blendDepthMood(depthMood, scrollPx, width)
  const shift = voyageScrollX(scrollPx)
  const sx = x + shift

  const beachReach = (1 - mood) * width * 0.58
  const shelfY = waterLineY + maxDepth * (0.1 + mood * 0.12)
  const abyssY = waterLineY + maxDepth * (0.38 + mood * 0.56)

  if (sx < beachReach) {
    const localT = sx / Math.max(1, beachReach)
    const eased = localT * localT * (3 - 2 * localT)
    const shoreY = waterLineY + maxDepth * (0.02 + (1 - mood) * 0.06)
    return shoreY + eased * (shelfY - shoreY)
  }

  const oceanT = Math.max(0, Math.min(1, (sx - beachReach) / Math.max(1, width * 1.1 - beachReach)))
  const eased = oceanT * oceanT * (3 - 2 * oceanT)
  return shelfY + eased * (abyssY - shelfY)
}
