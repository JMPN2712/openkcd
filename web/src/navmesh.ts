// KCD navigation mesh (recast.pak: recast/rdnavmesh_<name>.nav): Detour's
// tile format, version 14, with Warhorse's vertex packing. Written from the
// format note in the research notes (navmesh-format.md) and Detour's public
// documentation. Tiles are 16 m squares in game coordinates (z up). The 95 MB
// Rataje mesh holds 58,056 tiles; only their offsets are indexed up front,
// tiles are decoded when a query reaches them.
//
// Pathfinding: A* over polygons (edge-midpoint distances), crossing tile borders
// by matching border edges of neighbouring tiles, then the funnel algorithm
// ("simple stupid funnel") over the portals for the final corner path.

export type Vec3 = [number, number, number];

/** Detour's tile magic, 'DNAV' */
const MAGIC = 0x444e4156;
const VERSION = 14;
/** polygons hold up to 6 vertices (Detour's DT_VERTS_PER_POLYGON) */
const MAX_VERTS = 6;
/** a neighbour code with this bit links across the tile border */
export const EXTERNAL_LINK = 0x8000;

/** .nav: build settings, then the tile count, then the tiles */
const NAV_SETTINGS_BYTES = 56;
/** tile header: 17 i32, 4 f32 agent settings, bmin, bmax, BV quantisation */
const TILE_HEADER_BYTES = 17 * 4 + 4 * 4 + 3 * 4 + 3 * 4 + 4;
const POLY_BYTES = 28;
const DETAIL_MESH_BYTES = 10;
const DETAIL_TRI_BYTES = 4;
const OFFMESH_BYTES = 52;

/** Tile header counts, by i32 index. */
const H = { magic: 0, version: 1, x: 2, y: 3, layer: 4, polys: 6, verts: 7, packedVerts: 8, detailMeshes: 11, detailVerts: 12, detailTris: 13, offMesh: 15 } as const;

/** Packed vertex bit fields: x 11 bits at 21, y 11 bits at 10, z 10 bits at 0. */
const PACKED = [{ shift: 21, bits: 11 }, { shift: 10, bits: 11 }, { shift: 0, bits: 10 }] as const;

export interface NavTile {
  x: number;
  y: number;
  layer: number;
  bmin: Vec3;
  bmax: Vec3;
  /** xyz per vertex */
  verts: Float32Array;
  polyCount: number;
  /** MAX_VERTS vertex indices per poly */
  polyVerts: Uint16Array;
  /** MAX_VERTS neighbours per poly: 0 none, n = poly n−1, EXTERNAL_LINK = across the tile border */
  polyNeis: Uint16Array;
  /** vertices per poly (2 = off-mesh connection) */
  polyN: Uint8Array;
}

interface TileRef {
  offset: number;
  x: number;
  y: number;
  layer: number;
}

/** A polygon: tile + index; `point` = the closest point on it to the query (findPoly). */
export interface PolyRef {
  tile: NavTile;
  poly: number;
  point?: Vec3;
}

/** Byte size of the tile whose header starts at `o`. */
function tileBytes(dv: DataView, o: number): number {
  const n = (k: number) => dv.getInt32(o + k * 4, true);
  const packed = n(H.packedVerts);
  return TILE_HEADER_BYTES + packed * 4 + (n(H.verts) - packed) * 12 + n(H.polys) * POLY_BYTES
    + n(H.detailMeshes) * DETAIL_MESH_BYTES + n(H.detailVerts) * 12 + n(H.detailTris) * DETAIL_TRI_BYTES + n(H.offMesh) * OFFMESH_BYTES;
}

/** Decode one tile at byte offset `o`. */
export function decodeTile(dv: DataView, o: number): NavTile {
  const n = (k: number) => dv.getInt32(o + k * 4, true);
  if (n(H.magic) !== MAGIC || n(H.version) !== VERSION) throw new Error(`navmesh: no DNAV v${VERSION} tile at byte ${o}`);
  const vec = (at: number): Vec3 => [dv.getFloat32(at, true), dv.getFloat32(at + 4, true), dv.getFloat32(at + 8, true)];
  const bounds = o + 17 * 4 + 4 * 4;
  const bmin = vec(bounds), bmax = vec(bounds + 12);
  const vertCount = n(H.verts), packed = n(H.packedVerts), polyCount = n(H.polys);
  let p = o + TILE_HEADER_BYTES;
  const verts = new Float32Array(vertCount * 3);
  for (let v = 0; v < packed; v++, p += 4) {
    const word = dv.getUint32(p, true);
    PACKED.forEach(({ shift, bits }, axis) => {
      const max = (1 << bits) - 1;
      const q = (word >>> shift) & max;
      verts[v * 3 + axis] = bmin[axis] + (q / max) * (bmax[axis] - bmin[axis]);
    });
  }
  for (let v = packed; v < vertCount; v++, p += 12) verts.set(vec(p), v * 3);
  const polyVerts = new Uint16Array(polyCount * MAX_VERTS);
  const polyNeis = new Uint16Array(polyCount * MAX_VERTS);
  const polyN = new Uint8Array(polyCount);
  for (let k = 0; k < polyCount; k++, p += POLY_BYTES) {
    for (let j = 0; j < MAX_VERTS; j++) {
      polyVerts[k * MAX_VERTS + j] = dv.getUint16(p + j * 2, true);
      polyNeis[k * MAX_VERTS + j] = dv.getUint16(p + 12 + j * 2, true);
    }
    polyN[k] = dv.getUint8(p + 25); // byte 24 is flags/area, 26–27 more flags
  }
  return { x: n(H.x), y: n(H.y), layer: n(H.layer), bmin, bmax, verts, polyCount, polyVerts, polyNeis, polyN };
}

export class NavMesh {
  private dv: DataView;
  private refs = new Map<string, TileRef[]>();
  private tiles = new Map<number, NavTile>();
  readonly tileCount: number;
  readonly tileSize: number;

  constructor(bytes: Uint8Array) {
    const dv = (this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    this.tileCount = dv.getInt32(NAV_SETTINGS_BYTES, true);
    let o = NAV_SETTINGS_BYTES + 4;
    let size = 16;
    for (let t = 0; t < this.tileCount; t++) {
      if (dv.getUint32(o, true) !== MAGIC || dv.getInt32(o + 4, true) !== VERSION) throw new Error(`navmesh: no DNAV v${VERSION} tile at byte ${o} (tile ${t})`);
      const ref: TileRef = { offset: o, x: dv.getInt32(o + H.x * 4, true), y: dv.getInt32(o + H.y * 4, true), layer: dv.getInt32(o + H.layer * 4, true) };
      const key = `${ref.x},${ref.y}`;
      const list = this.refs.get(key);
      if (list) list.push(ref);
      else this.refs.set(key, [ref]);
      if (t === 0) {
        const bounds = o + 17 * 4 + 4 * 4;
        size = dv.getFloat32(bounds + 12, true) - dv.getFloat32(bounds, true);
      }
      o += tileBytes(dv, o);
    }
    if (o !== dv.byteLength) throw new Error(`navmesh: tiles end at ${o}, file is ${dv.byteLength} bytes`);
    this.tileSize = Math.round(size);
  }

  private decode(ref: TileRef): NavTile {
    let tile = this.tiles.get(ref.offset);
    if (!tile) this.tiles.set(ref.offset, (tile = decodeTile(this.dv, ref.offset)));
    return tile;
  }

  /** Every tile, decoded one at a time (for whole-mesh checks; not cached). */
  *allTiles(): Generator<NavTile> {
    for (const list of this.refs.values()) for (const r of list) yield decodeTile(this.dv, r.offset);
  }

  /** Decoded tiles (all layers) of tile cell (x, y). */
  tilesAt(x: number, y: number): NavTile[] {
    return (this.refs.get(`${x},${y}`) ?? []).map((r) => this.decode(r));
  }

  private tilesNear(p: Vec3): NavTile[] {
    const s = this.tileSize;
    return this.tilesAt(Math.floor(p[0] / s), Math.floor(p[1] / s));
  }

  /** Polygon under (or nearest to, within `range` m horizontally) a point, preferring the closest floor height. */
  findPoly(p: Vec3, range = 3): PolyRef | null {
    let best: PolyRef | null = null;
    let bestD = Infinity;
    const s = this.tileSize;
    const tx = Math.floor(p[0] / s), ty = Math.floor(p[1] / s);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const tile of this.tilesAt(tx + dx, ty + dy)) {
        for (let k = 0; k < tile.polyCount; k++) {
          const n = tile.polyN[k];
          if (n < 3) continue; // off-mesh connection
          const d = polyDistance(tile, k, p);
          if (d.h <= range) {
            const score = d.h * 4 + Math.abs(d.point[2] - p[2]);
            if (score < bestD) { bestD = score; best = { tile, poly: k, point: d.point }; }
          }
        }
      }
    }
    return best;
  }

  /** Neighbour polygons of a polygon with their portal (shared edge segment). */
  private neighbours(ref: PolyRef): { to: PolyRef; a: Vec3; b: Vec3 }[] {
    const { tile, poly } = ref;
    const n = tile.polyN[poly];
    const out: { to: PolyRef; a: Vec3; b: Vec3 }[] = [];
    for (let j = 0; j < n; j++) {
      const nei = tile.polyNeis[poly * MAX_VERTS + j];
      if (nei === 0) continue;
      const a = vert(tile, tile.polyVerts[poly * MAX_VERTS + j]);
      const b = vert(tile, tile.polyVerts[poly * MAX_VERTS + ((j + 1) % n)]);
      if (!(nei & EXTERNAL_LINK)) {
        out.push({ to: { tile, poly: nei - 1 }, a, b });
        continue;
      }
      // external: the edge lies on a tile border; find the overlapping border edge next door
      const eps = 0.01;
      let dx = 0, dy = 0, axis = 0;
      if (Math.abs(a[0] - tile.bmax[0]) < eps && Math.abs(b[0] - tile.bmax[0]) < eps) { dx = 1; axis = 1; }
      else if (Math.abs(a[0] - tile.bmin[0]) < eps && Math.abs(b[0] - tile.bmin[0]) < eps) { dx = -1; axis = 1; }
      else if (Math.abs(a[1] - tile.bmax[1]) < eps && Math.abs(b[1] - tile.bmax[1]) < eps) { dy = 1; axis = 0; }
      else if (Math.abs(a[1] - tile.bmin[1]) < eps && Math.abs(b[1] - tile.bmin[1]) < eps) { dy = -1; axis = 0; }
      else continue;
      const lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
      for (const other of this.tilesAt(tile.x + dx, tile.y + dy)) {
        for (let k = 0; k < other.polyCount; k++) {
          const m = other.polyN[k];
          if (m < 3) continue;
          for (let i = 0; i < m; i++) {
            if (!(other.polyNeis[k * MAX_VERTS + i] & EXTERNAL_LINK)) continue;
            const c = vert(other, other.polyVerts[k * MAX_VERTS + i]);
            const d = vert(other, other.polyVerts[k * MAX_VERTS + ((i + 1) % m)]);
            const fixed = 1 - axis;
            if (Math.abs(c[fixed] - a[fixed]) > eps || Math.abs(d[fixed] - a[fixed]) > eps) continue;
            const olo = Math.max(lo, Math.min(c[axis], d[axis])), ohi = Math.min(hi, Math.max(c[axis], d[axis]));
            if (ohi - olo < 0.05) continue;
            // same floor: heights at the overlap close (climb 0.32 m, quantisation)
            const at = (u: Vec3, v: Vec3, t: number) => u[2] + (v[2] - u[2]) * (Math.abs(v[axis] - u[axis]) < 1e-6 ? 0 : (t - u[axis]) / (v[axis] - u[axis]));
            const mid = (olo + ohi) / 2;
            if (Math.abs(at(a, b, mid) - at(c, d, mid)) > 0.6) continue;
            const pa: Vec3 = [0, 0, 0], pb: Vec3 = [0, 0, 0];
            pa[fixed] = a[fixed]; pb[fixed] = a[fixed];
            pa[axis] = olo; pb[axis] = ohi;
            pa[2] = at(a, b, olo); pb[2] = at(a, b, ohi);
            out.push({ to: { tile: other, poly: k }, a: pa, b: pb });
          }
        }
      }
    }
    return out;
  }

  /**
   * Path from `start` to `end` over the navmesh: corner points (start and end included),
   * or null when either end is off the mesh or no route is found within `maxNodes` expansions.
   */
  findPath(from: Vec3, to: Vec3, maxNodes = 20000): Vec3[] | null {
    const s = this.findPoly(from), e = this.findPoly(to);
    if (!s || !e) return null;
    // the path runs between the closest points on the mesh; callers bridge the last metres
    const start = s.point!, end = e.point!;
    const key = (r: PolyRef) => `${r.tile.x},${r.tile.y},${r.tile.layer},${r.poly}`;
    const ek = key(e);
    interface Node { ref: PolyRef; g: number; f: number; pos: Vec3; parent: Node | null; portal: [Vec3, Vec3] | null }
    const open: Node[] = [];
    const best = new Map<string, number>();
    const push = (n: Node) => {
      // binary heap on f
      open.push(n);
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (open[p].f <= open[i].f) break;
        [open[p], open[i]] = [open[i], open[p]];
        i = p;
      }
    };
    const pop = (): Node => {
      const top = open[0];
      const last = open.pop()!;
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < open.length && open[l].f < open[m].f) m = l;
          if (r < open.length && open[r].f < open[m].f) m = r;
          if (m === i) break;
          [open[m], open[i]] = [open[i], open[m]];
          i = m;
        }
      }
      return top;
    };
    const h = (p: Vec3) => dist(p, end);
    push({ ref: s, g: 0, f: h(start), pos: start, parent: null, portal: null });
    best.set(key(s), 0);
    let found: Node | null = null;
    for (let it = 0; open.length && it < maxNodes; it++) {
      const cur = pop();
      const ck = key(cur.ref);
      if ((best.get(ck) ?? Infinity) < cur.g) continue;
      if (ck === ek) { found = cur; break; }
      for (const nb of this.neighbours(cur.ref)) {
        const mid: Vec3 = [(nb.a[0] + nb.b[0]) / 2, (nb.a[1] + nb.b[1]) / 2, (nb.a[2] + nb.b[2]) / 2];
        const g = cur.g + dist(cur.pos, mid);
        const nk = key(nb.to);
        if (g >= (best.get(nk) ?? Infinity)) continue;
        best.set(nk, g);
        push({ ref: nb.to, g, f: g + h(mid), pos: mid, parent: cur, portal: [nb.a, nb.b] });
      }
    }
    if (!found) return null;
    const chain: Node[] = [];
    for (let n: Node | null = found; n; n = n.parent) chain.push(n);
    chain.reverse();
    // portals, oriented (left, right) relative to the travel direction across each one
    const portals: [Vec3, Vec3][] = [[start, start]];
    for (let k = 1; k < chain.length; k++) {
      const [a, b] = chain[k].portal!;
      const from = k === 1 ? start : chain[k - 1].pos;
      const to = k + 1 < chain.length ? chain[k + 1].pos : end;
      const dir: Vec3 = [to[0] - from[0], to[1] - from[1], 0];
      // left = positive cross(dir, p − from) (z up, counter-clockwise)
      const side = (p: Vec3) => dir[0] * (p[1] - from[1]) - dir[1] * (p[0] - from[0]);
      portals.push(side(a) >= side(b) ? [a, b] : [b, a]);
    }
    portals.push([end, end]);
    return funnel(portals);
  }
}

function vert(t: NavTile, i: number): Vec3 {
  return [t.verts[i * 3], t.verts[i * 3 + 1], t.verts[i * 3 + 2]];
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Horizontal distance from p to polygon k (0 inside) and the closest point on it: p itself
 * when inside (height from the poly's plane), else the nearest point on its boundary.
 */
function polyDistance(t: NavTile, k: number, p: Vec3): { h: number; point: Vec3 } {
  const n = t.polyN[k];
  let inside = false;
  let minD = Infinity;
  let point: Vec3 = p;
  const v0 = vert(t, t.polyVerts[k * MAX_VERTS]);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = vert(t, t.polyVerts[k * MAX_VERTS + i]), b = vert(t, t.polyVerts[k * MAX_VERTS + j]);
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    // closest point on edge ab
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const l2 = ex * ex + ey * ey || 1;
    const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / l2));
    const d = Math.hypot(a[0] + ex * u - p[0], a[1] + ey * u - p[1]);
    if (d < minD) { minD = d; point = [a[0] + ex * u, a[1] + ey * u, a[2] + (b[2] - a[2]) * u]; }
  }
  if (!inside) return { h: minD, point };
  // inside: height on the plane through the first three vertices
  const v1 = vert(t, t.polyVerts[k * MAX_VERTS + 1]), v2 = vert(t, t.polyVerts[k * MAX_VERTS + 2]);
  const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
  const wx = v2[0] - v0[0], wy = v2[1] - v0[1], wz = v2[2] - v0[2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const z = Math.abs(nz) > 1e-9 ? v0[2] - (nx * (p[0] - v0[0]) + ny * (p[1] - v0[1])) / nz : v0[2];
  return { h: 0, point: [p[0], p[1], z] };
}

/** Funnel ("simple stupid funnel") over (left, right) portals in the xy plane. */
function funnel(portals: [Vec3, Vec3][]): Vec3[] {
  const tri = (a: Vec3, b: Vec3, c: Vec3) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]); // > 0: c left of ab
  const eq = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;
  const path: Vec3[] = [portals[0][0]];
  let apex = portals[0][0], left = portals[0][0], right = portals[0][1];
  let apexI = 0, leftI = 0, rightI = 0;
  for (let i = 1; i < portals.length; i++) {
    const [l, r] = portals[i];
    // tighten the right side
    if (tri(apex, right, r) >= 0) {
      if (eq(apex, right) || tri(apex, left, r) < 0) {
        right = r; rightI = i;
      } else {
        path.push(left);
        apex = left; apexI = leftI;
        left = apex; right = apex; leftI = rightI = apexI;
        i = apexI;
        continue;
      }
    }
    // tighten the left side
    if (tri(apex, left, l) <= 0) {
      if (eq(apex, left) || tri(apex, right, l) > 0) {
        left = l; leftI = i;
      } else {
        path.push(right);
        apex = right; apexI = rightI;
        left = apex; right = apex; leftI = rightI = apexI;
        i = apexI;
        continue;
      }
    }
  }
  const end = portals[portals.length - 1][0];
  if (!eq(path[path.length - 1], end)) path.push(end);
  return path;
}
