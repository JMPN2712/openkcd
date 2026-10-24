// Roads (octree type 11): paths and tracks laid over the terrain as blended
// meshes (Illum %DECAL%VERTCOLORS materials under Materials/terrain/roads/).
// 14,710 in Rataje with 3.8M vertices, so each road is read from terrain.dat
// (stored uncompressed in level.pak) only when it streams in.
//
// A road record (levelObjects.ts has the header) holds a mesh built by the
// editor: V vertices of 12 bytes (half x, y, z relative to the record's
// bounding-box centre, half alpha fading the edges, half u, v), then I u16
// indices. The data after them (8 bytes per vertex, 12 per outline point)
// isn't needed to draw it.

import type { CgfMesh } from "./cgf.ts";
import type { RoadIndex } from "./levelObjects.ts";

/** Roads sit about 4 cm under the bilinear terrain surface; lifted a little so they don't sink into it. */
const LIFT = 0.06;

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? NaN : s * (1 + m / 1024) * 2 ** (e - 15);
}

/** A road's mesh from its record bytes, in coordinates relative to its centre. */
export function roadMesh(record: Uint8Array): CgfMesh {
  const dv = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const nv = dv.getUint32(80, true), ni = dv.getUint32(84, true);
  const positions = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2), colors = new Uint8Array(nv * 4);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // (no arrays per vertex or triangle: hundreds of roads are read per streaming step)
  colors.fill(255);
  for (let i = 0; i < nv; i++) {
    const o = 108 + i * 12;
    for (let k = 0; k < 3; k++) {
      const v = half(dv.getUint16(o + k * 2, true)) + (k === 2 ? LIFT : 0);
      positions[i * 3 + k] = v;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    colors[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, half(dv.getUint16(o + 6, true)))) * 255);
    uvs[i * 2] = half(dv.getUint16(o + 8, true));
    uvs[i * 2 + 1] = half(dv.getUint16(o + 10, true));
  }
  const ib = 108 + nv * 12;
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) indices[i] = dv.getUint16(ib + i * 2, true);
  // smooth normals from the triangles (the road follows the ground)
  const normals = new Float32Array(nv * 3);
  const P = positions;
  for (let t = 0; t + 2 < ni; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = P[b] - P[a], ay = P[b + 1] - P[a + 1], az = P[b + 2] - P[a + 2];
    const bx = P[c] - P[a], by = P[c + 1] - P[a + 1], bz = P[c + 2] - P[a + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; } // facing up whatever the winding
    normals[a] += nx; normals[a + 1] += ny; normals[a + 2] += nz;
    normals[b] += nx; normals[b + 1] += ny; normals[b + 2] += nz;
    normals[c] += nx; normals[c + 1] += ny; normals[c + 2] += nz;
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1;
    if (l === 1 && !normals[i * 3 + 2]) normals[i * 3 + 2] = 1;
    else for (let k = 0; k < 3; k++) normals[i * 3 + k] /= l;
  }
  return {
    nodeName: "road",
    transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    positions, normals, tangents: null, uvs, colors, boneIds: null, boneWeights: null, indices,
    subsets: [{ firstIndex: 0, numIndices: ni, firstVert: 0, numVerts: nv, matId: 0 }],
    bboxMin: min, bboxMax: max,
  };
}

/** Reads road records out of terrain.dat in the level pak. */
export class Roads {
  private blob: Blob;
  private start: Promise<number>;
  readonly index: RoadIndex;

  /** `dataStart`: where terrain.dat's bytes begin in the (stored, uncompressed) level pak */
  constructor(blob: Blob, dataStart: Promise<number>, index: RoadIndex) {
    this.blob = blob;
    this.start = dataStart;
    this.index = index;
  }

  get count(): number {
    return this.index.radius.length;
  }

  center(i: number): [number, number, number] {
    const c = this.index.center;
    return [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
  }

  priority(i: number): number {
    return this.index.priority[i];
  }

  material(i: number): number {
    return this.index.material[i];
  }

  /** Roads whose bounds come within `radius` of `center` (xy). */
  near(center: [number, number], radius: number): number[] {
    const out: number[] = [];
    const c = this.index.center, r = this.index.radius;
    for (let i = 0; i < r.length; i++) {
      if (Math.hypot(c[i * 3] - center[0], c[i * 3 + 1] - center[1]) - r[i] <= radius) out.push(i);
    }
    return out;
  }

  private meshes = new Map<number, Promise<CgfMesh>>();

  async mesh(i: number): Promise<CgfMesh> {
    let m = this.meshes.get(i);
    if (!m) {
      m = this.start.then(async (start) => {
        const s = start + this.index.offset[i];
        return roadMesh(new Uint8Array(await this.blob.slice(s, s + this.index.size[i]).arrayBuffer()));
      });
      this.meshes.set(i, m);
      // keep the last couple of thousand (a long walk would otherwise keep every road it passed)
      if (this.meshes.size > 2048) this.meshes.delete(this.meshes.keys().next().value!);
    }
    return m;
  }

  /**
   * Roads `ids` (same material) as one mesh, relative to the first road's centre: one draw
   * instead of one per road (Rataje's streamed radius holds hundreds).
   */
  async merged(ids: number[]): Promise<CgfMesh> {
    const parts = await Promise.all(ids.map((i) => this.mesh(i)));
    const c = this.index.center, o = ids[0] * 3;
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.positions.length / 3; ni += p.indices.length; }
    const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), uvs = new Float32Array(nv * 2), colors = new Uint8Array(nv * 4), indices = new Uint32Array(ni);
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let v = 0, k = 0;
    parts.forEach((p, n) => {
      const d = [0, 1, 2].map((a) => c[ids[n] * 3 + a] - c[o + a]);
      const count = p.positions.length / 3;
      for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
        const x = p.positions[i * 3 + a] + d[a];
        positions[(v + i) * 3 + a] = x;
        min[a] = Math.min(min[a], x);
        max[a] = Math.max(max[a], x);
      }
      normals.set(p.normals!, v * 3);
      uvs.set(p.uvs!, v * 2);
      colors.set(p.colors!, v * 4);
      for (let i = 0; i < p.indices.length; i++) indices[k + i] = p.indices[i] + v;
      v += count;
      k += p.indices.length;
    });
    return { ...parts[0], positions, normals, uvs, colors, indices, subsets: [{ firstIndex: 0, numIndices: ni, firstVert: 0, numVerts: nv, matId: 0 }], bboxMin: min, bboxMax: max };
  }
}
