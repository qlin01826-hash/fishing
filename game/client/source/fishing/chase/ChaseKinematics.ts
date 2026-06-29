import type { Vector3 } from './math/Vector3'
import type { Euler3 } from './math/Vector3'

/** Align penguin body with the active track tangent (roll/pitch from hydrodynamic flow). */
export function orientationFromTangent(tangent: Vector3): Euler3 {
  return {
    pitch: Math.atan2(tangent.y, Math.max(0.15, tangent.z)) * 0.55,
    yaw: Math.atan2(tangent.x, Math.max(0.15, tangent.z)),
    roll: Math.max(-0.22, Math.min(0.22, -tangent.x * 0.62)),
  }
}
