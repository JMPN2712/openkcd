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

export class Animator {
  readonly skeleton: Skeleton;
  private localRot: Quat[] = [];
  private localPos: Vec3[] = [];
  /** model-space bone matrices of the last evaluate() */
  readonly world: Float32Array[];
  /** the pelvis/hips: the root's child with the largest subtree (cameras follow it) */
  readonly centerBone: number;

  constructor(skeleton: Skeleton) {
    this.skeleton = skeleton;
    for (const b of skeleton.bones) {
      const parent = b.parent >= 0 ? skeleton.bones[b.parent].bindPose : null;
      const local = parent ? multiply(invertRigid(parent), b.bindPose) : b.bindPose;
      this.localRot.push(matToQuat(local));
      this.localPos.push([local[12], local[13], local[14]]);
    }
    this.world = skeleton.bones.map((b) => b.bindPose);
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

  /**
   * Evaluate the clip at `frame` (null clip = bind pose). Bones are ordered parents-first in CompiledBones.
   * `inPlace` drops the root bone's animated translation (locomotion clips carry their forward
   * motion there: relaxed_walk_medium moves the root 3.03 m over its 65 frames).
   */
  evaluate(clip: Clip | null, frame: number, inPlace = false): Float32Array[] {
    const bones = this.skeleton.bones;
    for (let i = 0; i < bones.length; i++) {
      const track = clip?.tracks.get(bones[i].controllerId);
      const rot = (track && sampleRot(track, frame)) ?? this.localRot[i];
      const pos = (inPlace && bones[i].parent < 0 ? null : track && samplePos(track, frame)) ?? this.localPos[i];
      const local = quatPosMatrix(rot, pos);
      const p = bones[i].parent;
      this.world[i] = p >= 0 ? multiply(this.world[p], local) : local;
    }
    return this.world;
  }

  /**
   * Skinning palette for a mesh weighted to `meshBones` (its own bone list):
   * palette[i] = world(bone) × inverse(bind pose of the mesh's bone i).
   */
  palette(meshBones: Skeleton): Float32Array {
    const out = new Float32Array(meshBones.bones.length * 16);
    meshBones.bones.forEach((b, i) => {
      const j = this.skeleton.byName.get(b.name.toLowerCase());
      const m = j === undefined ? new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) : multiply(this.world[j], invertRigid(b.bindPose));
      out.set(m, i * 16);
    });
    return out;
  }
}
