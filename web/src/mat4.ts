// Minimal column-major 4×4 matrix helpers (WGSL convention, depth 0..1).

export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const r = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  return r;
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

/**
 * Reversed-Z perspective with an infinite far plane: depth is near / distance (1 at the near
 * plane, → 0 far away). With a depth32float buffer and "greater" this keeps precision from a
 * 1 cm near plane (the first-person body) out to the horizon.
 */
export function perspectiveReversed(fovY: number, aspect: number, near: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, 0, -1,
    0, 0, near, 0,
  ]);
}

/** How a render pass is set up: MSAA samples and the depth convention, shared by every renderer drawing into it. */
export interface PassSetup {
  sampleCount: number;
  /** reversed-Z depth (depth32float, "greater", cleared to 0) */
  reversedZ: boolean;
}

/** The model and character viewers: 4× MSAA, depth24plus, "less". */
export const DEFAULT_PASS: PassSetup = { sampleCount: 4, reversedZ: false };

export const depthFormat = (p: PassSetup): GPUTextureFormat => (p.reversedZ ? "depth32float" : "depth24plus");
export const depthCompare = (p: PassSetup): GPUCompareFunction => (p.reversedZ ? "greater" : "less");
export const depthClear = (p: PassSetup): number => (p.reversedZ ? 0 : 1);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
