// Static collision for the player: the streamed world's objects as triangles in a lazily built
// grid of 4 m cells, plus the terrain heightmap. What each model collides with (docs/PHYSICS.md):
//
//   proxy    its physics proxies ($physics_proxy… nodes: boxes, capsules, cylinders, spheres,
//            proxy meshes), plus any render mesh that is physicalised itself
//   render   no proxies, but the render mesh is physicalised (its physics data shares the render
//            vertices): the render triangles, or the subsets whose triangle count matches
//   visible  no physics data at all: FALLBACK to the simplified visible mesh (LOD1 when present),
//            opaque subsets only (alpha-tested foliage and cloth fringes left out)
//   none     vegetation without physics (grass, bushes), decals, uber-LODs, and door / animated
//            .cdf skins (doors open in the game; until interaction exists they don't block)

import { tessellate } from "./physics.ts";
import type { LoadedModel } from "./model.ts";
import type { WorldModel, WorldScene } from "./world.ts";
import type { Surroundings, Vec3 } from "./player.ts";

export type CollisionSource = "proxy" | "render" | "visible" | "none";

export interface CollisionShape {
  source: CollisionSource;
  /** model-space triangles */
  positions: Float32Array;
  indices: Uint32Array;
}

const NO_COLLISION = /(^|\/)decals?\/|decal_|^objects\/uberlods\//;

function transformed(m: LoadedModel, include: (mesh: LoadedModel["cgf"]["meshes"][number]) => number[][] | null): { positions: number[]; indices: number[] } {
  const P: number[] = [], I: number[] = [];
  for (const mesh of m.cgf.meshes) {
    const ranges = include(mesh);
    if (!ranges?.length) continue;
    const t = mesh.transform;
    const base = P.length / 3;
    const n = mesh.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
      P.push(t[0] * x + t[4] * y + t[8] * z + t[12], t[1] * x + t[5] * y + t[9] * z + t[13], t[2] * x + t[6] * y + t[10] * z + t[14]);
    }
    for (const [first, count] of ranges) for (let k = 0; k < count; k++) I.push(base + mesh.indices[first + k]);
  }
  return { positions: P, indices: I };
}

/** Subsets of a physicalised render mesh: all of them, or a combination with the physics triangle count. */
function physicalisedSubsets(mesh: LoadedModel["cgf"]["meshes"][number]): number[][] | null {
  const nt = mesh.physicsTriangles;
  if (nt === undefined) return null;
  const subs = mesh.subsets;
  const total = subs.reduce((s, x) => s + x.numIndices / 3, 0);
  if (nt === total) return subs.map((s) => [s.firstIndex, s.numIndices]);
  const n = Math.min(subs.length, 16);
  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    for (let k = 0; k < n; k++) if (mask & (1 << k)) sum += subs[k].numIndices / 3;
    if (sum === nt) return subs.filter((_, k) => mask & (1 << k)).map((s) => [s.firstIndex, s.numIndices]);
  }
  return subs.map((s) => [s.firstIndex, s.numIndices]);
}

/** Choose and build a model's collision geometry (see the header). */
export function collisionShape(wm: Pick<WorldModel, "path" | "kind" | "lods">): CollisionShape {
  const none: CollisionShape = { source: "none", positions: new Float32Array(0), indices: new Uint32Array(0) };
  const base = wm.lods[0];
  if (NO_COLLISION.test(wm.path) || wm.path.includes("|") || wm.path.endsWith(".skin")) return none;
  const physical = transformed(base, physicalisedSubsets);
  if (base.cgf.physics.length) {
    const P = physical.positions, I = physical.indices;
    for (const g of base.cgf.physics) {
      const t = tessellate(g);
      if (!t) continue;
      const off = P.length / 3;
      for (const v of t.positions) P.push(v);
      for (const i of t.indices) I.push(off + i);
    }
    return { source: "proxy", positions: new Float32Array(P), indices: new Uint32Array(I) };
  }
  if (physical.indices.length) return { source: "render", positions: new Float32Array(physical.positions), indices: new Uint32Array(physical.indices) };
  if (wm.kind === "vegetation") return none;
  // no physics data: the simplified visible mesh, opaque subsets
  const m = wm.lods[1] ?? base;
  const opaque = (mesh: LoadedModel["cgf"]["meshes"][number]) => mesh.subsets
    .filter((s) => {
      const mat = m.materials[m.materials.length === 1 ? 0 : s.matId];
      return !mat?.nodraw && !(mat?.alphaTest && mat.alphaTest > 0);
    })
    .map((s) => [s.firstIndex, s.numIndices]);
  const vis = transformed(m, opaque);
  return vis.indices.length ? { source: "visible", positions: new Float32Array(vis.positions), indices: new Uint32Array(vis.indices) } : none;
}

const CELL = 4;
/** per triangle: 9 vertex floats, 3 normal floats, 6 AABB floats */
const TRI = 18;

interface Cell {
  tris: Float32Array;
  count: number;
}

export class CollisionWorld implements Surroundings {
  private shapes = new Map<string, CollisionShape>();
  private scene: WorldScene | null = null;
  /** instances overlapping each cell: model index, instance index */
  private bins = new Map<number, number[]>();
  private cells = new Map<number, Cell>();
  private terrainHeight: (x: number, y: number) => number;
  /** shapes chosen, by source (for the HUD and the report) */
  readonly stats: Record<CollisionSource, number> = { proxy: 0, render: 0, visible: 0, none: 0 };

  constructor(terrainHeight: (x: number, y: number) => number) {
    this.terrainHeight = terrainHeight;
  }

  floor(x: number, y: number): number {
    return this.terrainHeight(x, y);
  }

  shapeOf(wm: WorldModel): CollisionShape {
    let s = this.shapes.get(wm.path);
    if (!s) {
      s = collisionShape(wm);
      this.shapes.set(wm.path, s);
      this.stats[s.source]++;
    }
    return s;
  }

  /** Use a new streamed scene (instances are binned now, triangles when a cell is first needed). */
  setScene(scene: WorldScene): void {
    this.scene = scene;
    this.bins.clear();
    this.cells.clear();
    scene.models.forEach((wm, mi) => {
      if (wm.uber || NO_COLLISION.test(wm.path)) return;
      for (let i = 0; i < wm.count; i++) {
        const x = wm.spheres[i * 4], y = wm.spheres[i * 4 + 1], r = wm.spheres[i * 4 + 3];
        const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL), y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue; // a stand-in the size of a town block
        for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
          const k = key(cx, cy);
          let b = this.bins.get(k);
          if (!b) this.bins.set(k, (b = []));
          b.push(mi, i);
        }
      }
    });
  }

  private cell(cx: number, cy: number): Cell | null {
    const k = key(cx, cy);
    let c = this.cells.get(k);
    if (c) return c;
    const bin = this.bins.get(k);
    if (!bin || !this.scene) return null;
    const lo = [cx * CELL - 0.5, cy * CELL - 0.5], hi = [(cx + 1) * CELL + 0.5, (cy + 1) * CELL + 0.5];
    const out: number[] = [];
    for (let j = 0; j < bin.length; j += 2) {
      const wm = this.scene.models[bin[j]];
      const shape = this.shapeOf(wm);
      if (!shape.indices.length) continue;
      const m = wm.matrices.subarray(bin[j + 1] * 16, bin[j + 1] * 16 + 16);
      const P = shape.positions, I = shape.indices;
      const v = new Float64Array(9);
      for (let t = 0; t < I.length; t += 3) {
        for (let c3 = 0; c3 < 3; c3++) {
          const i = I[t + c3] * 3, x = P[i], y = P[i + 1], z = P[i + 2];
          v[c3 * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          v[c3 * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          v[c3 * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const minx = Math.min(v[0], v[3], v[6]), maxx = Math.max(v[0], v[3], v[6]);
        const miny = Math.min(v[1], v[4], v[7]), maxy = Math.max(v[1], v[4], v[7]);
        if (maxx < lo[0] || minx > hi[0] || maxy < lo[1] || miny > hi[1]) continue;
        const ex = v[3] - v[0], ey = v[4] - v[1], ez = v[5] - v[2], fx = v[6] - v[0], fy = v[7] - v[1], fz = v[8] - v[2];
        let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-9) continue;
        nx /= nl; ny /= nl; nz /= nl;
        out.push(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], nx, ny, nz, minx, miny, Math.min(v[2], v[5], v[8]), maxx, maxy, Math.max(v[2], v[5], v[8]));
      }
    }
    c = { tris: new Float32Array(out), count: out.length / TRI };
    this.cells.set(k, c);
    return c;
  }

  /** Triangles in the cells overlapping a box (each cell once). */
  private *cellsIn(x0: number, y0: number, x1: number, y1: number): Generator<Cell> {
    for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++)
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        const c = this.cell(cx, cy);
        if (c?.count) yield c;
      }
  }

  ground(x: number, y: number, zTop: number, zBottom: number): { z: number; normal: Vec3 } | null {
    let best: { z: number; normal: Vec3 } | null = null;
    const tz = this.terrainHeight(x, y);
    if (tz <= zTop && tz >= zBottom) {
      const e = 0.5, h = this.terrainHeight;
      const nx = h(x - e, y) - h(x + e, y), ny = h(x, y - e) - h(x, y + e);
      const l = Math.hypot(nx, ny, 2 * e);
      best = { z: tz, normal: [nx / l, ny / l, (2 * e) / l] };
    }
    for (const c of this.cellsIn(x, y, x, y)) {
      const T = c.tris;
      for (let t = 0; t < c.count; t++) {
        const o = t * TRI;
        if (x < T[o + 12] || x > T[o + 15] || y < T[o + 13] || y > T[o + 16] || T[o + 14] > zTop || T[o + 17] < zBottom) continue;
        const nz = T[o + 11];
        if (Math.abs(nz) < 0.05) continue; // walls
        // barycentric in XY
        const ax = T[o], ay = T[o + 1], bx = T[o + 3], by = T[o + 4], cx = T[o + 6], cy = T[o + 7];
        const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(d) < 1e-12) continue;
        const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
        const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        const z = u * T[o + 2] + v * T[o + 5] + (1 - u - v) * T[o + 8];
        if (z > zTop || z < zBottom || (best && z <= best.z)) continue;
        const s = nz < 0 ? -1 : 1; // the side facing up
        best = { z, normal: [T[o + 9] * s, T[o + 10] * s, nz * s] };
      }
    }
    return best;
  }

  raycast(from: Vec3, to: Vec3): number | null {
    let best: number | null = null;
    // terrain: march the segment in 0.25 m steps
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (from[2] + (to[2] - from[2]) * t < this.terrainHeight(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t)) { best = (i - 1) / n; break; }
    }
    const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    for (const c of this.cellsIn(Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1]))) {
      const T = c.tris;
      for (let k = 0; k < c.count; k++) {
        const o = k * TRI;
        if (T[o + 15] < Math.min(from[0], to[0]) || T[o + 12] > Math.max(from[0], to[0]) || T[o + 16] < Math.min(from[1], to[1]) || T[o + 13] > Math.max(from[1], to[1]) || T[o + 17] < Math.min(from[2], to[2]) || T[o + 14] > Math.max(from[2], to[2])) continue;
        // Möller–Trumbore
        const e1 = [T[o + 3] - T[o], T[o + 4] - T[o + 1], T[o + 5] - T[o + 2]], e2 = [T[o + 6] - T[o], T[o + 7] - T[o + 1], T[o + 8] - T[o + 2]];
        const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
        if (Math.abs(det) < 1e-12) continue;
        const s0 = [from[0] - T[o], from[1] - T[o + 1], from[2] - T[o + 2]];
        const u = (s0[0] * p[0] + s0[1] * p[1] + s0[2] * p[2]) / det;
        if (u < 0 || u > 1) continue;
        const q = [s0[1] * e1[2] - s0[2] * e1[1], s0[2] * e1[0] - s0[0] * e1[2], s0[0] * e1[1] - s0[1] * e1[0]];
        const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
        if (v < 0 || u + v > 1) continue;
        const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
        if (t >= 0 && t <= 1 && (best === null || t < best)) best = t;
      }
    }
    return best;
  }

  depenetrate(a: Vec3, b: Vec3, r: number): { push: Vec3; normal: Vec3 | null } {
    const A = [...a], B = [...b];
    const push: Vec3 = [0, 0, 0];
    let normal: Vec3 | null = null;
    const q = new Float64Array(6);
    for (const c of this.cellsIn(Math.min(A[0], B[0]) - r, Math.min(A[1], B[1]) - r, Math.max(A[0], B[0]) + r, Math.max(A[1], B[1]) + r)) {
      const T = c.tris;
      for (let t = 0; t < c.count; t++) {
        const o = t * TRI;
        if (T[o + 15] < Math.min(A[0], B[0]) - r || T[o + 12] > Math.max(A[0], B[0]) + r || T[o + 16] < Math.min(A[1], B[1]) - r || T[o + 13] > Math.max(A[1], B[1]) + r || T[o + 17] < Math.min(A[2], B[2]) - r || T[o + 14] > Math.max(A[2], B[2]) + r) continue;
        segmentTriangle(A, B, T, o, q);
        const dx = q[0] - q[3], dy = q[1] - q[4], dz = q[2] - q[5];
        const d = Math.hypot(dx, dy, dz);
        if (d >= r) continue;
        // push the capsule away from the closest point (through the face along its normal when the axis crosses it)
        let nx: number, ny: number, nz: number;
        if (d > 1e-6) { nx = dx / d; ny = dy / d; nz = dz / d; } else {
          const s = (A[0] - T[o]) * T[o + 9] + (A[1] - T[o + 1]) * T[o + 10] + (A[2] - T[o + 2]) * T[o + 11] < 0 ? -1 : 1;
          nx = T[o + 9] * s; ny = T[o + 10] * s; nz = T[o + 11] * s;
        }
        const k = r - d;
        for (const P of [A, B]) { P[0] += nx * k; P[1] += ny * k; P[2] += nz * k; }
        push[0] += nx * k; push[1] += ny * k; push[2] += nz * k;
        if (!normal || nz > normal[2]) normal = [nx, ny, nz];
      }
    }
    return { push, normal };
  }
}

const key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

/**
 * Closest points between segment AB and the triangle at T[o..o+8]: writes the segment point
 * (out 0..2) and the triangle point (out 3..5). Exact: the segment crossing the face, or the
 * nearest of the endpoint–face and segment–edge pairs.
 */
function segmentTriangle(A: number[], B: number[], T: Float32Array, o: number, out: Float64Array): void {
  const nx = T[o + 9], ny = T[o + 10], nz = T[o + 11];
  const da = (A[0] - T[o]) * nx + (A[1] - T[o + 1]) * ny + (A[2] - T[o + 2]) * nz;
  const db = (B[0] - T[o]) * nx + (B[1] - T[o + 1]) * ny + (B[2] - T[o + 2]) * nz;
  if ((da <= 0 && db >= 0) || (da >= 0 && db <= 0)) {
    const t = da === db ? 0 : da / (da - db);
    const p = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    const c = pointTriangle(p, T, o);
    if (Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) < 1e-6) { out.set([p[0], p[1], p[2], p[0], p[1], p[2]]); return; }
  }
  let best = Infinity;
  for (const P of [A, B]) {
    const c = pointTriangle(P, T, o);
    const d = (c[0] - P[0]) ** 2 + (c[1] - P[1]) ** 2 + (c[2] - P[2]) ** 2;
    if (d < best) { best = d; out.set([P[0], P[1], P[2], c[0], c[1], c[2]]); }
  }
  for (let e = 0; e < 3; e++) {
    const p = o + e * 3, q = o + ((e + 1) % 3) * 3;
    const r = segmentSegment(A, B, [T[p], T[p + 1], T[p + 2]], [T[q], T[q + 1], T[q + 2]]);
    const d = (r[0] - r[3]) ** 2 + (r[1] - r[4]) ** 2 + (r[2] - r[5]) ** 2;
    if (d < best) { best = d; out.set(r); }
  }
}

/** Closest point on a triangle to p (Voronoi regions of vertices, edges, face). */
function pointTriangle(p: number[], T: Float32Array, o: number): number[] {
  const a = [T[o], T[o + 1], T[o + 2]], b = [T[o + 3], T[o + 4], T[o + 5]], c = [T[o + 6], T[o + 7], T[o + 8]];
  const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** Closest points between segments p1q1 and p2q2: [point on the first, point on the second]. */
function segmentSegment(p1: number[], q1: number[], p2: number[], q2: number[]): number[] {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = d1[0] ** 2 + d1[1] ** 2 + d1[2] ** 2, e = d2[0] ** 2 + d2[1] ** 2 + d2[2] ** 2;
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s: number, t: number;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; } else if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); } else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
    if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
      const den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s, p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
}
