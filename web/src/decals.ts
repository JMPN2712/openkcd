// Octree decals (type 7, 20,212 in Rataje): mud, cracks, moss, burn marks,
// puddles, blood and straw projected onto the ground and floors, with
// %DECAL materials (Objects/nature/city_generic/decal_*.mtl). Drawn like the
// roads: blended onto the ground right after the terrain, merged per
// material and priority.
//
// Record (116 bytes, decoded from the data, see docs/LEVELS.md): u32 type, AABB,
// u32, u32, u8 × 4 (+36), u32 (+40), Vec3 centre (+44), then the projection box
// as three axes, each as long as the box's half-size: normal (+56, pointing
// away from the surface), right (+68), up (+80); a second normal (+92), f32
// (+104, 1.0), i32 material (+108), u32 sort priority (+112).

import type { CgfMesh } from "./cgf.ts";
import type { Terrain } from "./terrain.ts";
import { heightAt } from "./terrain.ts";

export interface DecalIndex {
  /** centre, normal, right and up axes: 12 floats per decal */
  box: Float32Array;
  material: Int32Array;
  priority: Uint16Array;
}

export function parseDecal(dv: DataView, p: number, out: DecalIndex, i: number): void {
  for (let k = 0; k < 12; k++) out.box[i * 12 + k] = dv.getFloat32(p + 44 + k * 4, true);
  out.material[i] = dv.getInt32(p + 108, true);
  out.priority[i] = dv.getUint32(p + 112, true);
}

/** Grid steps across a decal of this half-size: draped decals need enough vertices to follow the ground. */
const steps = (half: number) => Math.max(2, Math.min(12, Math.ceil(half)));
/** Drawn this far above the terrain (the ground pass also pulls decals towards the eye). */
const LIFT = 0.03;

export class Decals {
  readonly index: DecalIndex;
  private terrain: Terrain;

  constructor(index: DecalIndex, terrain: Terrain) {
    this.index = index;
    this.terrain = terrain;
  }

  get count(): number {
    return this.index.material.length;
  }

  center(i: number): [number, number, number] {
    const b = this.index.box;
    return [b[i * 12], b[i * 12 + 1], b[i * 12 + 2]];
  }

  priority(i: number): number {
    return this.index.priority[i];
  }

  material(i: number): number {
    return this.index.material[i];
  }

  near(center: [number, number], radius: number): number[] {
    const out: number[] = [];
    const b = this.index.box;
    for (let i = 0; i < this.count; i++) {
      const o = i * 12;
      const half = Math.max(Math.hypot(b[o + 6], b[o + 7], b[o + 8]), Math.hypot(b[o + 9], b[o + 10], b[o + 11]));
      if (Math.hypot(b[o] - center[0], b[o + 1] - center[1]) - half <= radius) out.push(i);
    }
    return out;
  }

  /** Decals `ids` as one mesh relative to the first one's centre. */
  async merged(ids: number[]): Promise<CgfMesh> {
    const b = this.index.box, t = this.terrain;
    const origin = this.center(ids[0]);
    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
    for (const i of ids) {
      const o = i * 12;
      const c = [b[o], b[o + 1], b[o + 2]];
      const n = [b[o + 3], b[o + 4], b[o + 5]], r = [b[o + 6], b[o + 7], b[o + 8]], u = [b[o + 9], b[o + 10], b[o + 11]];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const nn = n.map((x) => x / nl);
      // ground decals (facing up, centred near the terrain) are draped onto it; others (floors,
      // streets, walls) lie in their plane
      const drape = nn[2] > 0.7 && Math.abs(c[2] - heightAt(t, c[0], c[1])) < 1;
      const s = steps(Math.max(Math.hypot(r[0], r[1], r[2]), Math.hypot(u[0], u[1], u[2])));
      const first = pos.length / 3;
      for (let y = 0; y <= s; y++) for (let x = 0; x <= s; x++) {
        const a = (x / s) * 2 - 1, v = (y / s) * 2 - 1;
        const p = [0, 1, 2].map((k) => c[k] + r[k] * a + u[k] * v);
        if (drape) p[2] = heightAt(t, p[0], p[1]) + LIFT;
        pos.push(p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]);
        nrm.push(nn[0], nn[1], nn[2]);
        uv.push(x / s, 1 - y / s);
      }
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const q = first + y * (s + 1) + x;
        idx.push(q, q + 1, q + s + 2, q, q + s + 2, q + s + 1);
      }
    }
    const nv = pos.length / 3;
    const positions = new Float32Array(pos);
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i * 3 + k]);
      max[k] = Math.max(max[k], positions[i * 3 + k]);
    }
    return {
      nodeName: "decals",
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      positions, normals: new Float32Array(nrm), tangents: null, uvs: new Float32Array(uv), colors: new Uint8Array(nv * 4).fill(255),
      boneIds: null, boneWeights: null, indices: new Uint32Array(idx),
      subsets: [{ firstIndex: 0, numIndices: idx.length, firstVert: 0, numVerts: nv, matId: 0 }],
      bboxMin: min, bboxMax: max,
    };
  }
}
