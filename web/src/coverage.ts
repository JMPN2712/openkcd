// Skin hidden under clothing. Garments sit a centimetre or two over the body, and where the body
// is fuller than the garment (toes and insteps in shoes, knees in hose) the skin pokes through.
// Every part of a character is stored in the bind pose in model space, so this is decided once
// per character, geometrically: a body vertex is covered when a short ray along its normal, out
// to just above the skin or in to just under it, meets a garment's surface. Body triangles with
// all three vertices covered are left out. (Our own approach: it doesn't depend on how the game
// does it.)

import type { CgfMesh } from "./cgf.ts";
import type { LoadedModel } from "./model.ts";

/** Garment surface counts within this far outside the skin, and this far inside it (poking through). */
const OUT = 0.04;
const IN = 0.03;
const CELL = 0.05;

interface Tri { a: number; b: number; c: number; p: Float32Array }

/** World (model-space) positions of a mesh: its node transform applied. */
function positionsOf(m: CgfMesh): Float32Array {
  const t = m.transform, P = m.positions, out = new Float32Array(P.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    out[i] = t[0] * x + t[4] * y + t[8] * z + t[12];
    out[i + 1] = t[1] * x + t[5] * y + t[9] * z + t[13];
    out[i + 2] = t[2] * x + t[6] * y + t[10] * z + t[14];
  }
  return out;
}

/** Garment triangles bucketed in a uniform grid. */
class TriGrid {
  private cells = new Map<number, number[]>();
  tris: Tri[] = [];
  private key(x: number, y: number, z: number): number {
    return ((Math.floor(x / CELL) + 512) * 1024 + (Math.floor(y / CELL) + 512)) * 1024 + (Math.floor(z / CELL) + 512);
  }

  add(m: CgfMesh): void {
    const p = positionsOf(m), I = m.indices;
    for (let t = 0; t + 2 < I.length; t += 3) {
      const tri = { a: I[t] * 3, b: I[t + 1] * 3, c: I[t + 2] * 3, p };
      const id = this.tris.push(tri) - 1;
      const lo = [0, 1, 2].map((k) => Math.min(p[tri.a + k], p[tri.b + k], p[tri.c + k]));
      const hi = [0, 1, 2].map((k) => Math.max(p[tri.a + k], p[tri.b + k], p[tri.c + k]));
      for (let x = Math.floor(lo[0] / CELL); x <= Math.floor(hi[0] / CELL); x++)
        for (let y = Math.floor(lo[1] / CELL); y <= Math.floor(hi[1] / CELL); y++)
          for (let z = Math.floor(lo[2] / CELL); z <= Math.floor(hi[2] / CELL); z++) {
            const k = this.key(x * CELL, y * CELL, z * CELL);
            const l = this.cells.get(k);
            if (l) l.push(id); else this.cells.set(k, [id]);
          }
    }
  }

  private stamp = new Uint32Array(0);
  private visit = 0;

  /** Whether the segment from o to o + d·len crosses any triangle. */
  hits(o: [number, number, number], d: [number, number, number], len: number): boolean {
    if (this.stamp.length < this.tris.length) this.stamp = new Uint32Array(this.tris.length);
    this.visit++;
    const e = [o[0] + d[0] * len, o[1] + d[1] * len, o[2] + d[2] * len];
    for (let x = Math.floor(Math.min(o[0], e[0]) / CELL); x <= Math.floor(Math.max(o[0], e[0]) / CELL); x++)
      for (let y = Math.floor(Math.min(o[1], e[1]) / CELL); y <= Math.floor(Math.max(o[1], e[1]) / CELL); y++)
        for (let z = Math.floor(Math.min(o[2], e[2]) / CELL); z <= Math.floor(Math.max(o[2], e[2]) / CELL); z++) {
          for (const id of this.cells.get(this.key(x * CELL, y * CELL, z * CELL)) ?? []) {
            if (this.stamp[id] === this.visit) continue;
            this.stamp[id] = this.visit;
            if (rayTri(o, d, len, this.tris[id])) return true;
          }
        }
    return false;
  }
}

/** Möller–Trumbore, both faces, within [0, len]. */
function rayTri(o: [number, number, number], d: [number, number, number], len: number, t: Tri): boolean {
  const P = t.p;
  const e1x = P[t.b] - P[t.a], e1y = P[t.b + 1] - P[t.a + 1], e1z = P[t.b + 2] - P[t.a + 2];
  const e2x = P[t.c] - P[t.a], e2y = P[t.c + 1] - P[t.a + 1], e2z = P[t.c + 2] - P[t.a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const sx = o[0] - P[t.a], sy = o[1] - P[t.a + 1], sz = o[2] - P[t.a + 2];
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return dist >= 0 && dist <= len;
}

/**
 * The body model without its covered triangles (a copy: models can be shared), or the model
 * itself when nothing is covered. `garments` are the clothing meshes worn over it.
 */
export function hideCoveredSkin(body: LoadedModel, garments: CgfMesh[], opts: { from?: [number, number, number] } = {}): { model: LoadedModel; hidden: number } {
  if (!garments.length) return { model: body, hidden: 0 };
  const grid = new TriGrid();
  for (const g of garments) grid.add(g);
  let hidden = 0;
  // (with `from`, the rays run outward from that point instead of along the normals: hair cards'
  // normals point every way, and hair poking through a hat is outward from the head)
  const from = opts.from;
  const meshes = body.cgf.meshes.map((m) => {
    if (!m.normals && !from) return m;
    const P = positionsOf(m), N = m.normals, t = m.transform, nv = P.length / 3;
    const covered = new Uint8Array(nv);
    for (let i = 0; i < nv; i++) {
      // the normal in model space (node transforms of skins are rotations at most)
      let wx: number, wy: number, wz: number;
      if (from) {
        wx = P[i * 3] - from[0]; wy = P[i * 3 + 1] - from[1]; wz = P[i * 3 + 2] - from[2];
      } else {
        const nx = N![i * 3], ny = N![i * 3 + 1], nz = N![i * 3 + 2];
        wx = t[0] * nx + t[4] * ny + t[8] * nz; wy = t[1] * nx + t[5] * ny + t[9] * nz; wz = t[2] * nx + t[6] * ny + t[10] * nz;
      }
      const l = Math.hypot(wx, wy, wz) || 1;
      const d: [number, number, number] = [wx / l, wy / l, wz / l];
      const o: [number, number, number] = [P[i * 3] - d[0] * IN, P[i * 3 + 1] - d[1] * IN, P[i * 3 + 2] - d[2] * IN];
      covered[i] = grid.hits(o, d, IN + OUT) ? 1 : 0;
    }
    const indices: number[] = [];
    const subsets = m.subsets.map((s) => {
      const first = indices.length;
      for (let k = s.firstIndex; k + 2 < s.firstIndex + s.numIndices; k += 3) {
        const a = m.indices[k], b = m.indices[k + 1], c = m.indices[k + 2];
        if (covered[a] && covered[b] && covered[c]) { hidden++; continue; }
        indices.push(a, b, c);
      }
      return { ...s, firstIndex: first, numIndices: indices.length - first };
    });
    return { ...m, indices: Uint32Array.from(indices), subsets };
  });
  if (!hidden) return { model: body, hidden: 0 };
  return { model: { ...body, cgf: { ...body.cgf, meshes } }, hidden };
}
