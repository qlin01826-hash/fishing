/** Native 3D coordinate used by chase logic (swappable to a 3D engine later). */
export class Vector3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z)
  }

  set(x: number, y: number, z: number): this {
    this.x = x
    this.y = y
    this.z = z
    return this
  }

  copy(v: Vector3): this {
    return this.set(v.x, v.y, v.z)
  }

  add(v: Vector3): this {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }

  sub(v: Vector3): this {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }

  scale(s: number): this {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }

  length(): number {
    return Math.hypot(this.x, this.y, this.z)
  }

  normalize(): this {
    const len = this.length()
    if (len > 1e-6) this.scale(1 / len)
    return this
  }

  static lerp(a: Vector3, b: Vector3, t: number, out = new Vector3()): Vector3 {
    out.x = a.x + (b.x - a.x) * t
    out.y = a.y + (b.y - a.y) * t
    out.z = a.z + (b.z - a.z) * t
    return out
  }
}

export interface Euler3 {
  pitch: number
  yaw: number
  roll: number
}
