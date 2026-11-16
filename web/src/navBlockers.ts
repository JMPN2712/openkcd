// Walls the navmesh doesn't know. Rataje's one navmesh (recast/rdnavmesh_1.nav) runs straight
// across Skalitz's palisade beside its gates, perhaps because it was built with the burned village
// (sv_state1) whose palisade has gaps. Routes and the crowd then took NPCs through the wall. This
// collects the footprints of the walls and fences drawn now (brushes of shown layers): each piece
// an oriented rectangle from its model's bounds and the brush's matrix. Gates, ropes, grass strips,
// loose stones and anything lower than 0.5 m are left out, so gateways stay open.
// The navmesh's own routes keep off the palisade (no route around Skalitz crosses a piece): it was
// the crowd's steering (avoidance, catching up with a plan, the last steps to a spot) that walked
// NPCs through it. The crowd refuses steps through these walls (npcs.ts), and a route that would
// cross one is planned again around it (navmesh.ts findPath).

import type { Vfs } from "./vfs.ts";
import { parseCgf } from "./cgf.ts";

/** An upright oriented box: centre, unit long axis, half sizes along it and across, height range. */
export interface Blocker {
  cx: number; cy: number;
  ux: number; uy: number;
  hu: number; hv: number;
  z0: number; z1: number;
  /** what it is (debugging): wall, wall piece, join */
  kind?: string;
}

/** Wall and fence models that block a walk. */
// (fences are left out: the navmesh's routes cross garden fences in many places this doesn't model
// yet, their gaps and stiles; see docs/HANDOFF.md)
export const WALL_MODEL = /\/(wall_wooden|palisade_vranik|ironworks)\/[^/]*(wall|palisade|spike)[^/]*\.cgf$/i;
const NOT_A_WALL = /gate|rope|grass|planter|stone_wall_loose|lamp|mechanism|vitis|_end\.cgf|pivot/i;

const CELL = 8;

export class Blockers {
  readonly list: Blocker[];
  private grid = new Map<string, number[]>();

  constructor(list: Blocker[]) {
    this.list = list;
    list.forEach((b, i) => {
      const r = Math.hypot(b.hu, b.hv);
      for (let x = Math.floor((b.cx - r) / CELL); x <= Math.floor((b.cx + r) / CELL); x++) {
        for (let y = Math.floor((b.cy - r) / CELL); y <= Math.floor((b.cy + r) / CELL); y++) {
          const k = `${x},${y}`;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i);
        }
      }
    });
  }

  private near(x0: number, y0: number, x1: number, y1: number): Set<number> {
    const out = new Set<number>();
    for (let x = Math.floor(Math.min(x0, x1) / CELL); x <= Math.floor(Math.max(x0, x1) / CELL); x++) {
      for (let y = Math.floor(Math.min(y0, y1) / CELL); y <= Math.floor(Math.max(y0, y1) / CELL); y++) {
        for (const i of this.grid.get(`${x},${y}`) ?? []) out.add(i);
      }
    }
    return out;
  }

  /** Whether the walk from p to q (feet heights) crosses a wall, the walls grown by `pad` metres. */
  crosses(p: readonly number[], q: readonly number[], pad = 0): boolean {
    for (const i of this.near(p[0] - pad, p[1] - pad, q[0] + pad, q[1] + pad)) {
      const b = this.list[i];
      const z = Math.min(p[2], q[2]);
      if (z > b.z1 || Math.max(p[2], q[2]) + 1.7 < b.z0) continue;
      if (segmentHitsBox(b, p, q, pad)) return true;
    }
    return false;
  }

  /** The first wall the walk from p to q crosses (debugging). */
  hit(p: readonly number[], q: readonly number[], pad = 0): Blocker | null {
    for (const i of this.near(p[0] - pad, p[1] - pad, q[0] + pad, q[1] + pad)) {
      const b = this.list[i];
      if (Math.min(p[2], q[2]) > b.z1 || Math.max(p[2], q[2]) + 1.7 < b.z0) continue;
      if (segmentHitsBox(b, p, q, pad)) return b;
    }
    return null;
  }

  /** Whether point p lies in a wall grown by `pad`. */
  inside(p: readonly number[], pad = 0): boolean {
    return this.crosses(p, p, pad);
  }
}

/** Segment p–q against box b grown by pad (the box's frame: slab test). */
function segmentHitsBox(b: Blocker, p: readonly number[], q: readonly number[], pad: number): boolean {
  const loc = (x: number, y: number) => {
    const dx = x - b.cx, dy = y - b.cy;
    return [dx * b.ux + dy * b.uy, -dx * b.uy + dy * b.ux];
  };
  const a = loc(p[0], p[1]), c = loc(q[0], q[1]);
  const half = [b.hu + pad, b.hv + pad];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    const d = c[k] - a[k];
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(a[k]) > half[k]) return false;
      continue;
    }
    let ta = (-half[k] - a[k]) / d, tb = (half[k] - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The shown walls and fences: brushes (`objects`, names from `brushNames`) of layers not in `hidden`
 * whose model is a wall. Model bounds are read once per model.
 */
export async function wallBlockers(
  vfs: Vfs,
  objects: { brushName: Uint32Array; brushLayer: Uint32Array; brushMatrix: Float32Array },
  brushNames: string[],
  hidden: Set<number>,
  cache = new Map<string, { lo: number[]; hi: number[] } | null>(),
): Promise<Blocker[]> {
  const out: Blocker[] = [];
  const bounds = async (path: string) => {
    if (cache.has(path)) return cache.get(path)!;
    let b: { lo: number[]; hi: number[] } | null = null;
    const hit = vfs.lookup(path);
    if (hit) {
      try {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const m of parseCgf(await vfs.read(hit)).meshes) {
          const P = m.positions, t = m.transform;
          for (let v = 0; v < P.length; v += 3) for (let r = 0; r < 3; r++) {
            const x = t[r] * P[v] + t[4 + r] * P[v + 1] + t[8 + r] * P[v + 2] + t[12 + r];
            lo[r] = Math.min(lo[r], x); hi[r] = Math.max(hi[r], x);
          }
        }
        if (lo[0] <= hi[0]) b = { lo, hi };
      } catch { b = null; }
    }
    cache.set(path, b);
    return b;
  };
  const M = objects.brushMatrix;
  // palisade pieces (joined to their neighbours below) and gates (never joined across)
  const posts: Blocker[] = [], gates: Blocker[] = [];
  for (let i = 0; i < objects.brushName.length; i++) {
    if (hidden.has(objects.brushLayer[i])) continue;
    const raw = (brushNames[objects.brushName[i]] ?? "").toLowerCase().replace(/\\/g, "/");
    // the level's own collision boxes (%level%/brush/designer_*.cgf: no triangles, physics only)
    const collision = /^%level%\/brush\/designer_\d+\.cgf$/.test(raw);
    const name = raw.replace(/^%level%\//, "");
    // (any gate: a palisade's, a fence's, a castle's; their gateways stay open)
    const gate = /gate/.test(name) && !/mechanism|burned/.test(name);
    // (the level's collision boxes are left out: the navmesh, built from the physics, crosses many on
    // roads and in gateways, so they are barriers switched per story state, not walls)
    if (collision) continue;
    if (!gate && (!WALL_MODEL.test(name) || NOT_A_WALL.test(name))) continue;
    const b = await bounds(name);
    if (!b) continue;
    const m = M.subarray(i * 16, i * 16 + 16);
    // the box's corners in world space (scale and rotation in the matrix)
    const corner = (x: number, y: number, z: number) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
    const c = corner((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, b.lo[2]);
    const ex = corner(b.hi[0], (b.lo[1] + b.hi[1]) / 2, b.lo[2]), ey = corner((b.lo[0] + b.hi[0]) / 2, b.hi[1], b.lo[2]);
    const top = corner((b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, b.hi[2]);
    const ax = [ex[0] - c[0], ex[1] - c[1]], ay = [ey[0] - c[0], ey[1] - c[1]];
    const lx = Math.hypot(ax[0], ax[1]), ly = Math.hypot(ay[0], ay[1]);
    if (top[2] - c[2] < 0.5 || (lx < 0.05 && ly < 0.05)) continue;
    // the long axis is u
    const [u, hu, hv] = lx >= ly ? [ax, lx, ly] : [ay, ly, lx];
    const ul = Math.hypot(u[0], u[1]) || 1;
    const box: Blocker = { cx: c[0], cy: c[1], ux: u[0] / ul, uy: u[1] / ul, hu, hv: Math.max(hv, 0.1), z0: Math.min(c[2], top[2]), z1: Math.max(c[2], top[2]) };
    box.kind = collision ? "collision" : PALISADE.test(name) ? "wall" : "wall piece";
    if (gate) { gates.push(box); continue; }
    // collision boxes: the upright, wall-like ones (a ramp or a floor box is no wall)
    if (collision && (box.z1 - box.z0 < 2.5 || box.hv > 1.2)) continue;
    // a wall piece is thin and short: a model whose bounds are a whole ring of walls (120 × 67 m
    // around Skalitz's castle) would wall in what it encloses
    if (!collision && !gate && (box.hv > 1.5 || box.hu > 15)) continue;
    out.push(box);
    if (PALISADE.test(name)) posts.push(box);
  }
  // collision boxes in a gateway (the shut gate's) leave it open: gates stand open here
  const gateIndex0 = new Blockers(gates);
  for (let i = out.length - 1; i >= 0; i--) {
    const b = out[i];
    if (b.kind === "collision" && (gateIndex0.inside([b.cx, b.cy, b.z0 + 1], Math.max(b.hv, 0.5)) || gates.some((g) => Math.hypot(g.cx - b.cx, g.cy - b.cy) < g.hu + 2))) out.splice(i, 1);
  }
  // collision boxes only along a palisade (its own collision, beside a gate's tower): elsewhere
  // they are road barriers and rocks whose purpose the data doesn't say
  const wallIndex = new Blockers(posts);
  for (let i = out.length - 1; i >= 0; i--) {
    const b = out[i];
    if (b.kind === "collision" && !wallIndex.crosses([b.cx - b.ux * b.hu, b.cy - b.uy * b.hu, b.z0 + 1], [b.cx + b.ux * b.hu, b.cy + b.uy * b.hu, b.z0 + 1], 3)) out.splice(i, 1);
  }
  // a palisade is short pieces and single spikes with gaps between them (up to 6 m beside
  // Skalitz's west gate): each piece is joined to its two nearest within JOIN m by a thin wall,
  // unless the join would cross a gate (the gateway stays open)
  const gateIndex = new Blockers(gates);
  const cell = new Map<string, number[]>();
  posts.forEach((b, i) => { const k = `${Math.floor(b.cx / JOIN)},${Math.floor(b.cy / JOIN)}`; (cell.get(k) ?? cell.set(k, []).get(k)!).push(i); });
  const joined = new Set<string>();
  posts.forEach((a, i) => {
    const near: [number, number][] = [];
    const gx = Math.floor(a.cx / JOIN), gy = Math.floor(a.cy / JOIN);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of cell.get(`${gx + dx},${gy + dy}`) ?? []) {
      if (j === i) continue;
      const b = posts[j], d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
      if (d > 0.3 && d <= JOIN && Math.abs(b.z0 - a.z0) < 1.5) near.push([d, j]);
    }
    near.sort((x, y) => x[0] - y[0]);
    for (const [d, j] of near.slice(0, 2)) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (joined.has(key)) continue;
      joined.add(key);
      const b = posts[j];
      if (gateIndex.crosses([a.cx, a.cy, a.z0], [b.cx, b.cy, b.z0], 0.3)) continue;
      out.push({ cx: (a.cx + b.cx) / 2, cy: (a.cy + b.cy) / 2, ux: (b.cx - a.cx) / d, uy: (b.cy - a.cy) / d, hu: d / 2, hv: 0.12, z0: Math.min(a.z0, b.z0), z1: Math.max(a.z1, b.z1), kind: "join" });
    }
  });
  return out;
}

/** Palisade pieces and spikes (joined into walls) */
const PALISADE = /\/(wall_wooden|palisade_vranik|ironworks)\/[^/]*(palisade|spike|wall_wooden_(top|bottom))/i;
/** Farthest apart two palisade pieces are joined (m) */
const JOIN = 6.5;
