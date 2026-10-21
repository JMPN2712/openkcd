// Merged-mesh sectors: the painted grass, ground plants and small debris of a
// level (terrain/merged_meshes_sectors/ in level.pak, about 25 million
// instances in Rataje, next to 1.5 million ordinary vegetation instances).
//
// Format (decoded from the data, see docs/LEVELS.md):
//   sector_<x>_<y>_<z>_<n>.dat: one 16 m cube of the world grid, possibly split in parts
//   blocks until the end of the file:
//     u32 0xCAFEBAB6, u32 x, u32 y, u32 z (sector indices), u32 vegetation group, u32 count
//     count × 12 bytes: u16 x, u16 y, u16 z (sector-relative, 16 m / 65536 per step),
//                       u8 scale (64 = 1), i8 × 4 quaternion x y z w (/127), u8 (unknown)
//   The vegetation group indexes the terrain's vegetation list (the model to draw).

import { readEntry, type PakEntry } from "./zip.ts";

export const SECTOR = 16; // metres
const MAGIC = 0xcafebab6;
const STEP = SECTOR / 65536;

export interface MergedInstances {
  /** vegetation group per instance */
  group: Uint16Array;
  /** column-major 4×4 per instance */
  matrices: Float32Array;
}

/** Instances of one sector file. */
export function parseSector(bytes: Uint8Array): MergedInstances {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (let o = 0; o + 24 <= bytes.length; ) {
    if (v.getUint32(o, true) !== MAGIC) throw new Error(`merged-mesh block without its marker at ${o}`);
    const n = v.getUint32(o + 20, true);
    total += n;
    o += 24 + n * 12;
  }
  const group = new Uint16Array(total);
  const matrices = new Float32Array(total * 16);
  let i = 0;
  for (let o = 0; o + 24 <= bytes.length; ) {
    const ox = v.getUint32(o + 4, true) * SECTOR, oy = v.getUint32(o + 8, true) * SECTOR, oz = v.getUint32(o + 12, true) * SECTOR;
    const g = v.getUint32(o + 16, true), n = v.getUint32(o + 20, true);
    o += 24;
    for (let k = 0; k < n; k++, o += 12, i++) {
      const s = bytes[o + 6] / 64;
      let qx = v.getInt8(o + 7), qy = v.getInt8(o + 8), qz = v.getInt8(o + 9), qw = v.getInt8(o + 10);
      const l = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= l; qy /= l; qz /= l; qw /= l;
      const m = matrices.subarray(i * 16, i * 16 + 16);
      // rotation from the quaternion, scaled; columns are the model's axes
      m[0] = (1 - 2 * (qy * qy + qz * qz)) * s; m[1] = 2 * (qx * qy + qz * qw) * s; m[2] = 2 * (qx * qz - qy * qw) * s;
      m[4] = 2 * (qx * qy - qz * qw) * s; m[5] = (1 - 2 * (qx * qx + qz * qz)) * s; m[6] = 2 * (qy * qz + qx * qw) * s;
      m[8] = 2 * (qx * qz + qy * qw) * s; m[9] = 2 * (qy * qz - qx * qw) * s; m[10] = (1 - 2 * (qx * qx + qy * qy)) * s;
      m[12] = ox + v.getUint16(o, true) * STEP;
      m[13] = oy + v.getUint16(o + 2, true) * STEP;
      m[14] = oz + v.getUint16(o + 4, true) * STEP;
      m[15] = 1;
      group[i] = g;
    }
  }
  return { group, matrices };
}

/** The sector files of a level pak, by 16 m column, with a cache of parsed sectors. */
export class MergedMeshes {
  private columns = new Map<number, PakEntry[]>();
  private cache = new Map<number, Promise<MergedInstances[]>>();
  private blob: Blob;

  constructor(blob: Blob, entries: PakEntry[]) {
    this.blob = blob;
    for (const e of entries) {
      const m = /merged_meshes_sectors\/sector_(\d+)_(\d+)_[^/]*\.dat$/i.exec(e.name);
      if (!m) continue;
      const key = Number(m[1]) * 65536 + Number(m[2]);
      const list = this.columns.get(key);
      if (list) list.push(e);
      else this.columns.set(key, [e]);
    }
  }

  get sectors(): number {
    return this.columns.size;
  }

  /** Instances of the 16 m column at grid cell (x, y). */
  column(x: number, y: number): Promise<MergedInstances[]> {
    const key = x * 65536 + y;
    let p = this.cache.get(key);
    if (!p) {
      p = Promise.all((this.columns.get(key) ?? []).map(async (e) => parseSector(await readEntry(this.blob, e, undefined, false))));
      this.cache.set(key, p);
      // keep roughly the last few thousand columns (a walk across the map would otherwise keep them all)
      if (this.cache.size > 4096) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  /** Every instance within `radius` of `center` (xy), as (group, matrix) pairs. */
  async near(center: [number, number], radius: number, visit: (group: number, m: Float32Array) => void): Promise<void> {
    const x0 = Math.max(0, Math.floor((center[0] - radius) / SECTOR)), x1 = Math.floor((center[0] + radius) / SECTOR);
    const y0 = Math.max(0, Math.floor((center[1] - radius) / SECTOR)), y1 = Math.floor((center[1] + radius) / SECTOR);
    const r2 = radius * radius;
    const jobs: Promise<MergedInstances[]>[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (this.columns.has(x * 65536 + y)) jobs.push(this.column(x, y));
    for (const parts of await Promise.all(jobs)) {
      for (const { group, matrices } of parts) {
        for (let i = 0; i < group.length; i++) {
          const m = matrices.subarray(i * 16, i * 16 + 16);
          if ((m[12] - center[0]) ** 2 + (m[13] - center[1]) ** 2 <= r2) visit(group[i], m);
        }
      }
    }
  }
}
