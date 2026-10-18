// Compiled skeleton (CompiledBones chunk 0x2000 v0x800) from a .chr or .skin.
// Every .skin carries its own copy of the bones it is weighted to; the .chr
// holds the full skeleton. Bones are matched across files by name.
//
// Layout (CE 3.x CompiledBone, 584 bytes, after a 32-byte reserved header):
//   u32 controllerId, BONE_PHYSICS_COMP[2] (104 B each), f32 mass,
//   Matrix34 defaultW2B, Matrix34 defaultB2W, char name[256],
//   i32 limbId, i32 offsetParent, i32 numChildren, i32 offsetChild
// Matrix34 is row-major 3×4 with the translation in the last column (metres).

import { CHUNK_SKELETON } from "./cgf.ts";

export interface Bone {
  name: string;
  /** index of the parent bone, -1 for the root */
  parent: number;
  controllerId: number;
  /** bind pose bone-to-model transform, column-major 4×4 */
  bindPose: Float32Array;
}

export interface Skeleton {
  bones: Bone[];
  byName: Map<string, number>;
}

const BONE_SIZE = 584;
const HEADER = 32;

function cstr(b: Uint8Array, o: number, max: number): string {
  let e = o;
  while (e < o + max && b[e]) e++;
  return new TextDecoder("latin1").decode(b.subarray(o, e));
}

/** Returns null if the file has no CompiledBones chunk. */
export function parseSkeleton(bytes: Uint8Array): Skeleton | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (cstr(bytes, 0, 4) !== "CrCh") throw new Error("not a CryEngine chunk file");
  const count = dv.getUint32(8, true);
  const table = dv.getUint32(12, true);
  for (let i = 0; i < count; i++) {
    const o = table + i * 16;
    if (dv.getUint16(o, true) !== CHUNK_SKELETON.CompiledBones) continue;
    const version = dv.getUint16(o + 2, true);
    if (version !== 0x800) throw new Error(`CompiledBones version ${version.toString(16)} not supported`);
    const size = dv.getUint32(o + 8, true);
    const start = dv.getUint32(o + 12, true);
    if ((size - HEADER) % BONE_SIZE) throw new Error(`CompiledBones size ${size} is not 32 + n×${BONE_SIZE}`);
    const n = (size - HEADER) / BONE_SIZE;
    const bones: Bone[] = [];
    const byName = new Map<string, number>();
    for (let b = 0; b < n; b++) {
      const bo = start + HEADER + b * BONE_SIZE;
      const m = bo + 4 + 208 + 4 + 48; // defaultB2W
      const bindPose = new Float32Array(16);
      // row-major 3×4 → column-major 4×4
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) bindPose[c * 4 + r] = dv.getFloat32(m + (r * 4 + c) * 4, true);
      bindPose[15] = 1;
      const name = cstr(bytes, m + 48, 256);
      const offsetParent = dv.getInt32(bo + 4 + 208 + 4 + 96 + 256 + 4, true);
      bones.push({ name, parent: offsetParent ? b + offsetParent : -1, controllerId: dv.getUint32(bo, true), bindPose });
      byName.set(name.toLowerCase(), b);
    }
    return { bones, byName };
  }
  return null;
}
