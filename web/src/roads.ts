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
  for (let i = 0; i < nv; i++) {
    const o = 108 + i * 12;
    for (let k = 0; k < 3; k++) {
      const v = half(dv.getUint16(o + k * 2, true)) + (k === 2 ? LIFT : 0);
      positions[i * 3 + k] = v;
      min[k] = Math.min(min[k], v);
      max[k] = Math.max(max[k], v);
    }
    colors.set([255, 255, 255, Math.round(Math.max(0, Math.min(1, half(dv.getUint16(o + 6, true)))) * 255)], i * 4);
    uvs[i * 2] = half(dv.getUint16(o + 8, true));
    uvs[i * 2 + 1] = half(dv.getUint16(o + 10, true));
  }
  const ib = 108 + nv * 12;
  const indices = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) indices[i] = dv.getUint16(ib + i * 2, true);
  // smooth normals from the triangles (the road follows the ground)
  const normals = new Float32Array(nv * 3);
  for (let t = 0; t + 2 < ni; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const e1 = [0, 1, 2].map((k) => positions[b * 3 + k] - positions[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => positions[c * 3 + k] - positions[a * 3 + k]);
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[2] < 0) n = n.map((x) => -x); // facing up whatever the winding
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += n[k];
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

  /** Roads whose bounds come within `radius` of `center` (xy). */
  near(center: [number, number], radius: number): number[] {
    const out: number[] = [];
    const c = this.index.center, r = this.index.radius;
    for (let i = 0; i < r.length; i++) {
      if (Math.hypot(c[i * 3] - center[0], c[i * 3 + 1] - center[1]) - r[i] <= radius) out.push(i);
    }
    return out;
  }

  async mesh(i: number): Promise<CgfMesh> {
    const s = (await this.start) + this.index.offset[i];
    return roadMesh(new Uint8Array(await this.blob.slice(s, s + this.index.size[i]).arrayBuffer()));
  }
}
