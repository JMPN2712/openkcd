// Skin hidden under clothing (and inner garments under outer ones). Garments sit a centimetre or
// two over the body, and where the body is fuller than the garment (toes and insteps in shoes,
// knees in hose) the skin pokes through.
// Every part of a character is stored in the bind pose in model space, so this is decided once
// per character, geometrically: a body vertex is covered when a short ray along its normal, out
// to just above the skin or in to just under it, meets a garment's surface. Body triangles with
// all three vertices covered are left out. (Our own approach: it doesn't depend on how the game
// does it.)

import type { CgfMesh } from "./cgf.ts";
import type { LoadedModel, MipChain } from "./model.ts";
import { decodeBC1, decodeBC2, decodeBC3, decodeBC7 } from "./bcn.ts";

/** Garment surface counts within this far outside the skin, and this far inside it (poking through). */
const OUT = 0.04;
const IN = 0.03;
const CELL = 0.05;

/** A garment mesh, with its model when its alpha-tested materials should count only where opaque. */
export interface Garment { mesh: CgfMesh; model?: LoadedModel }

/** An alpha-tested material's coverage: its diffuse alpha (one level, nearest texel) and threshold. */
interface AlphaMap { w: number; h: number; a: Uint8Array; test: number }

interface Tri { a: number; b: number; c: number; p: Float32Array; uv: Float32Array | null; alpha: AlphaMap | null }

/** Garment sleeves are often cut short by the texture's alpha: the geometry beyond covers nothing. */
function alphaMap(chain: MipChain | null, test: number): AlphaMap | null {
  if (!chain || chain.released || !chain.levels.length) return null;
  const l = chain.levels.find((v) => v.w <= 256) ?? chain.levels[chain.levels.length - 1];
  let rgba: Uint8Array | Uint8ClampedArray = l.data;
  if (chain.bc) {
    const f = chain.bc.format;
    const dec = f.startsWith("bc1") ? decodeBC1 : f.startsWith("bc2") ? decodeBC2 : f.startsWith("bc3") ? decodeBC3 : f.startsWith("bc7") ? decodeBC7 : null;
    if (!dec) return null;
    rgba = dec(l.data as Uint8Array, l.w, l.h);
  }
  const a = new Uint8Array(l.w * l.h);
  for (let i = 0; i < a.length; i++) a[i] = rgba[i * 4 + 3];
  return { w: l.w, h: l.h, a, test };
}

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

  add(g: Garment): void {
    const m = g.mesh, p = positionsOf(m), I = m.indices;
    const alphaOf = new Map<number, AlphaMap | null>();
    for (const s of m.subsets) {
      const mat = g.model?.materials[s.matId];
      if (mat?.nodraw) continue;
      let alpha = alphaOf.get(s.matId);
      if (alpha === undefined) alphaOf.set(s.matId, (alpha = mat && mat.alphaTest > 0 && m.uvs ? alphaMap(g.model!.diffuse[s.matId], mat.alphaTest) : null));
      for (let t = s.firstIndex; t + 2 < s.firstIndex + s.numIndices; t += 3) {
        const tri: Tri = { a: I[t] * 3, b: I[t + 1] * 3, c: I[t + 2] * 3, p, uv: m.uvs, alpha };
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

/** Möller–Trumbore, both faces, within [0, len]; an alpha-tested triangle only where it is opaque. */
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
  if (dist < 0 || dist > len) return false;
  const A = t.alpha;
  if (!A || !t.uv) return true;
  const ia = t.a / 3 * 2, ib = t.b / 3 * 2, ic = t.c / 3 * 2, w = 1 - u - v;
  const tu = t.uv[ia] * w + t.uv[ib] * u + t.uv[ic] * v, tv = t.uv[ia + 1] * w + t.uv[ib + 1] * u + t.uv[ic + 1] * v;
  const x = Math.min(A.w - 1, Math.floor((tu - Math.floor(tu)) * A.w)), y = Math.min(A.h - 1, Math.floor((tv - Math.floor(tv)) * A.h));
  return A.a[y * A.w + x] >= A.test * 255;
}

/**
 * The body model without its covered triangles (a copy: models can be shared), or the model
 * itself when nothing is covered. `garments` are the clothing meshes worn over it.
 */
export function hideCoveredSkin(body: LoadedModel, garments: Garment[], opts: { from?: [number, number, number] } = {}): { model: LoadedModel; hidden: number } {
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
