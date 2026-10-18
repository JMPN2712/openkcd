// Skeletal pose evaluation: samples a clip's per-bone local tracks (parent-
// relative rotation + translation), falls back to the bind pose for bones
// without tracks, and chains parent to child into model-space matrices.

import type { Clip, Quat, Track, Vec3 } from "./anim.ts";
import type { Skeleton } from "./skeleton.ts";
import { multiply } from "./mat4.ts";

/** Invert a rigid (rotation + translation) column-major 4×4. */
export function invertRigid(m: Float32Array): Float32Array {
  const r = new Float32Array(16);
  // transpose the 3×3
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) r[c * 4 + row] = m[row * 4 + c];
  for (let row = 0; row < 3; row++) r[12 + row] = -(r[row] * m[12] + r[4 + row] * m[13] + r[8 + row] * m[14]);
  r[15] = 1;
  return r;
}

export function matToQuat(m: Float32Array): Quat {
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = m;
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4;
  }
  return [x, y, z, w];
}

/** Column-major 4×4 from translation and an (x, y, z, w) quaternion. */
export function quatPosMatrix(q: Quat, p: Vec3): Float32Array {
  const [x, y, z, w] = q;
  const l = Math.hypot(x, y, z, w) || 1;
  const [X, Y, Z, W] = [x / l, y / l, z / l, w / l];
  return new Float32Array([
    1 - 2 * (Y * Y + Z * Z), 2 * (X * Y + Z * W), 2 * (X * Z - Y * W), 0,
    2 * (X * Y - Z * W), 1 - 2 * (X * X + Z * Z), 2 * (Y * Z + X * W), 0,
    2 * (X * Z + Y * W), 2 * (Y * Z - X * W), 1 - 2 * (X * X + Y * Y), 0,
    p[0], p[1], p[2], 1,
  ]);
}

function keyIndex(times: Float32Array, t: number): [number, number, number] {
  const n = times.length;
  if (n === 1 || t <= times[0]) return [0, 0, 0];
  if (t >= times[n - 1]) return [n - 1, n - 1, 0];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  return [lo, hi, (t - times[lo]) / (times[hi] - times[lo])];
}

function nlerp(a: Quat, b: Quat, f: number): Quat {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  const q: Quat = [a[0] + (b[0] * s - a[0]) * f, a[1] + (b[1] * s - a[1]) * f, a[2] + (b[2] * s - a[2]) * f, a[3] + (b[3] * s - a[3]) * f];
  const l = Math.hypot(...q) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function sampleRot(t: Track, frame: number): Quat | null {
  if (!t.rotations.length) return null;
  const [i, j, f] = keyIndex(t.rotTimes, frame);
  return nlerp(t.rotations[i], t.rotations[j], f);
}

function samplePos(t: Track, frame: number): Vec3 | null {
  if (!t.positions.length) return null;
  const [i, j, f] = keyIndex(t.posTimes, frame);
  const a = t.positions[i], b = t.positions[j];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** 4×4 column-major multiply into `out` (out may not alias a or b). */
function mulInto(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number): void {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
    out[o + c * 4] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
    out[o + c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
    out[o + c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
    out[o + c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
  }
}

/** Find the key interval for `t`: writes the two key indices and the blend factor into `out`. */
function keyInto(times: Float32Array, t: number, out: Float64Array): void {
  const n = times.length;
  if (n === 1 || t <= times[0]) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
  if (t >= times[n - 1]) { out[0] = n - 1; out[1] = n - 1; out[2] = 0; return; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid; else hi = mid;
  }
  out[0] = lo; out[1] = hi; out[2] = (t - times[lo]) / (times[hi] - times[lo]);
}

export class Animator {
  readonly skeleton: Skeleton;
  private localRot: Quat[] = [];
  private localPos: Vec3[] = [];
  private parents: Int32Array;
  /** model-space bone matrices of the last evaluate() (updated in place) */
  readonly world: Float32Array[];
  /** the pelvis/hips: the root's child with the largest subtree (cameras follow it) */
  readonly centerBone: number;
  /** per clip: each bone's track (resolved once) */
  private trackCache = new WeakMap<Clip, (Track | undefined)[]>();
  /** per mesh skeleton: joint index and inverse bind pose of each of its bones, and an output buffer */
  private plans = new Map<Skeleton, { joints: Int32Array; invBind: Float32Array; out: Float32Array }>();
  private local = new Float32Array(16);
  private key = new Float64Array(3);

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    for (const b of skeleton.bones) {
      const parent = b.parent >= 0 ? skeleton.bones[b.parent].bindPose : null;
      const local = parent ? multiply(invertRigid(parent), b.bindPose) : b.bindPose;
      this.localRot.push(matToQuat(local));
      this.localPos.push([local[12], local[13], local[14]]);
    }
    this.parents = Int32Array.from(skeleton.bones, (b) => b.parent);
    // copies: evaluate() writes into these
    this.world = skeleton.bones.map((b) => new Float32Array(b.bindPose));
    const size = new Array<number>(skeleton.bones.length).fill(1);
    for (let i = skeleton.bones.length - 1; i > 0; i--) {
      const p = skeleton.bones[i].parent;
      if (p >= 0) size[p] += size[i];
    }
    let best = 0;
    skeleton.bones.forEach((b, i) => { if (b.parent === 0 && size[i] > (best ? size[best] : 0)) best = i; });
    this.centerBone = best;
  }

  /** Model-space position of the center bone after the last evaluate(). */
  center(): [number, number, number] {
    const m = this.world[this.centerBone];
    return [m[12], m[13], m[14]];
  }

  private tracksOf(clip: Clip): (Track | undefined)[] {
    let t = this.trackCache.get(clip);
    if (!t) {
      t = this.skeleton.bones.map((b) => clip.tracks.get(b.controllerId));
      this.trackCache.set(clip, t);
    }
    return t;
  }

  /**
   * Evaluate the clip at `frame` (null clip = bind pose). Bones are ordered parents-first in CompiledBones.
   * `inPlace` drops the root bone's animated translation (locomotion clips carry their forward
   * motion there: relaxed_walk_medium moves the root 3.03 m over its 65 frames).
   * Allocation-free: samples into scratch storage and updates `world` in place.
   */
  evaluate(clip: Clip | null, frame: number, inPlace = false): Float32Array[] {
    const n = this.skeleton.bones.length;
    const tracks = clip ? this.tracksOf(clip) : null;
    const m = this.local, k = this.key;
    for (let i = 0; i < n; i++) {
      const track = tracks?.[i];
      // rotation (x, y, z, w)
      let x: number, y: number, z: number, w: number;
      if (track && track.rotations.length) {
        keyInto(track.rotTimes, frame, k);
        const a = track.rotations[k[0]], b = track.rotations[k[1]], f = k[2];
        const sgn = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
        x = a[0] + (b[0] * sgn - a[0]) * f; y = a[1] + (b[1] * sgn - a[1]) * f;
        z = a[2] + (b[2] * sgn - a[2]) * f; w = a[3] + (b[3] * sgn - a[3]) * f;
      } else {
        [x, y, z, w] = this.localRot[i];
      }
      const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
      x /= l; y /= l; z /= l; w /= l;
      // translation
      let px: number, py: number, pz: number;
      if (track && track.positions.length && !(inPlace && this.parents[i] < 0)) {
        keyInto(track.posTimes, frame, k);
        const a = track.positions[k[0]], b = track.positions[k[1]], f = k[2];
        px = a[0] + (b[0] - a[0]) * f; py = a[1] + (b[1] - a[1]) * f; pz = a[2] + (b[2] - a[2]) * f;
      } else {
        [px, py, pz] = this.localPos[i];
      }
      m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w); m[3] = 0;
      m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w); m[7] = 0;
      m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
      m[12] = px; m[13] = py; m[14] = pz; m[15] = 1;
      const p = this.parents[i];
      if (p >= 0) mulInto(this.world[i], 0, this.world[p], 0, m, 0);
      else this.world[i].set(m);
    }
    return this.world;
  }

  /**
   * Skinning palette for a mesh weighted to `meshBones` (its own bone list):
   * palette[i] = world(bone) × inverse(bind pose of the mesh's bone i).
   * Returns a buffer reused by later calls for the same mesh skeleton (upload it right away).
   */
  palette(meshBones: Skeleton): Float32Array {
    let plan = this.plans.get(meshBones);
    if (!plan) {
      const nb = meshBones.bones.length;
      const joints = new Int32Array(nb), invBind = new Float32Array(nb * 16);
      meshBones.bones.forEach((b, i) => {
        joints[i] = this.skeleton.byName.get(b.name.toLowerCase()) ?? -1;
        invBind.set(invertRigid(b.bindPose), i * 16);
      });
      plan = { joints, invBind, out: new Float32Array(nb * 16) };
      this.plans.set(meshBones, plan);
    }
    const { joints, invBind, out } = plan;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j < 0) { out.fill(0, i * 16, i * 16 + 16); out[i * 16] = out[i * 16 + 5] = out[i * 16 + 10] = out[i * 16 + 15] = 1; }
      else mulInto(out, i * 16, this.world[j], 0, invBind, i * 16);
    }
    return out;
  }
}
